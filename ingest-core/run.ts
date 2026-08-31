/**
 * Locad WFM — shared DuckDB ingestion core.
 *
 * Used by BOTH scripts/ingest.ts (manual CLI run) and worker/server.ts (the
 * automatic-on-upload path) — one implementation, so a rule fixed here is
 * fixed everywhere, not just wherever someone remembered to also patch.
 *
 * Rules enforced here, straight from claude/agreed-operating-process.md:
 *   1. Difference across the FULL scan sequence per worker-day, THEN filter
 *      to Packing — filtering first inflates gaps ~3x (documented mistake).
 *   2. Signature = SKU set (or SKUxqty for single-SKU orders).
 *   3. line_seq via ROW_NUMBER, not drop_duplicates.
 *   4. target_location captured from Packing-type rows only.
 *   5. Benchmark tier resolved once here, frozen into curated_packing.
 *   6. Rebuild semantics — DELETE + INSERT per affected work_date, never a
 *      plain append. This is also why the worker always re-downloads and
 *      re-processes the FULL current set of uploaded transaction/attendance
 *      files rather than just the newest one: a worker-day's duration
 *      depends on that worker's next scan, which may sit in a different
 *      file (the project's own "100k-row day split into halves" rule).
 */
import duckdb from "duckdb";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const MAX_PLAUSIBLE_DURATION_MIN = Number(process.env.MAX_PLAUSIBLE_DURATION_MIN ?? 60);

export type IngestInputs = {
  txDir: string; // directory of transaction-log files (.csv/.xlsx)
  attDir: string; // directory of attendance files (.csv/.xlsx)
  benchmarkFile: string;
  fallbackFile: string;
  skuMapFile: string;
  nameMapFile: string;
  databaseUrl: string;
  log?: (msg: string) => void;
};

/** Normalize every .xlsx/.xls in a directory to .csv. DuckDB reads CSV
 *  natively and reliably; xlsx parsing is delegated to SheetJS instead of
 *  DuckDB's less-mature excel extension. Returns the dir DuckDB should glob. */
export function normalizeToCsvDir(sourceDir: string): string {
  const files = fs.readdirSync(sourceDir);
  const hasXlsx = files.some((f) => f.toLowerCase().endsWith(".xlsx") || f.toLowerCase().endsWith(".xls"));
  if (!hasXlsx) return sourceDir;

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfm-ingest-"));
  for (const f of files) {
    const full = path.join(sourceDir, f);
    if (f.toLowerCase().endsWith(".csv")) {
      fs.copyFileSync(full, path.join(outDir, f));
    } else if (f.toLowerCase().endsWith(".xlsx") || f.toLowerCase().endsWith(".xls")) {
      const wb = XLSX.readFile(full);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      fs.writeFileSync(path.join(outDir, f.replace(/\.xlsx?$/i, ".csv")), csv);
    }
  }
  return outDir;
}

export async function runIngestion(inputs: IngestInputs): Promise<{ rawRows: number; curatedRows: number }> {
  const log = inputs.log ?? (() => {});
  const txDir = normalizeToCsvDir(inputs.txDir);
  const attDir = normalizeToCsvDir(inputs.attDir);

  const db = new duckdb.Database(":memory:");
  const con = db.connect();
  const run = (sql: string) =>
    new Promise<any[]>((resolve, reject) =>
      con.all(sql, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows)))
    );

  log(`Loading raw transaction logs from ${txDir} …`);
  await run(`
    CREATE OR REPLACE TABLE raw AS
    SELECT
      "Transaction User"       AS packer_login,
      "Client"                 AS client,
      "Shipment Order Code"    AS order_code,
      "SKU"                    AS sku,
      "Transaction Type"       AS txn_type,
      TRY_CAST("Action Pack Quantity" AS DOUBLE) AS pack_qty,
      TRY_CAST("Action UOM Quantity" AS DOUBLE)  AS uom_qty,
      TRY_CAST("Transaction Date" AS TIMESTAMP)  AS event_time,
      "Target Location"        AS target_location,
      COALESCE("Shipment Order Type", 'B2C') AS order_type,
      row_number() OVER ()     AS raw_row_id
    FROM read_csv_auto('${txDir}/*.csv', union_by_name=true, ALL_VARCHAR=false)
    WHERE "Transaction Date" IS NOT NULL AND "Transaction Date" != ''
  `);

  const [{ n: rawCount }] = await run(`SELECT count(*) AS n FROM raw`);
  log(`  ${rawCount} raw rows loaded`);

  log("Grouping into scan events and computing signatures…");
  await run(`
    CREATE OR REPLACE TABLE events AS
    WITH sku_agg AS (
      SELECT
        order_code, packer_login, event_time, txn_type, client, order_type,
        list_sort(list(DISTINCT sku)) AS sku_list,
        count(DISTINCT sku) AS n_lines,
        sum(uom_qty) AS total_uom,
        any_value(target_location) FILTER (WHERE txn_type = 'Packing') AS target_location
      FROM raw
      GROUP BY order_code, packer_login, event_time, txn_type, client, order_type
    )
    SELECT
      *,
      CASE
        WHEN n_lines = 1 THEN sku_list[1] || 'x' || CAST(round(total_uom) AS VARCHAR)
        ELSE array_to_string(sku_list, '|')
      END AS signature
    FROM sku_agg
  `);

  log("Computing durations across the full scan sequence (rule 1)…");
  await run(`
    CREATE OR REPLACE TABLE events_timed AS
    SELECT
      *,
      date_trunc('day', event_time) AS work_date,
      lead(event_time) OVER w AS next_event_time,
      lead(txn_type) OVER w AS next_action_type,
      date_diff('minute', event_time, lead(event_time) OVER w) AS raw_gap_min
    FROM events
    WINDOW w AS (PARTITION BY packer_login, date_trunc('day', event_time) ORDER BY event_time)
  `);

  await run(`
    CREATE OR REPLACE TABLE events_flagged AS
    SELECT
      *,
      CASE
        WHEN next_event_time IS NULL THEN 'no_next_action'
        WHEN raw_gap_min > ${MAX_PLAUSIBLE_DURATION_MIN} THEN 'exceeds_max_gap'
        ELSE 'ok'
      END AS duration_flag,
      CASE
        WHEN next_event_time IS NULL THEN NULL
        WHEN raw_gap_min > ${MAX_PLAUSIBLE_DURATION_MIN} THEN NULL
        ELSE raw_gap_min
      END AS order_duration_min
    FROM events_timed
  `);

  log("Loading benchmark tables and resolving signature vs. brand-fallback tier…");
  await run(`CREATE OR REPLACE TABLE benchmark_signature AS SELECT * FROM read_csv_auto('${inputs.benchmarkFile}')`);
  await run(`CREATE OR REPLACE TABLE brand_fallback AS SELECT * FROM read_csv_auto('${inputs.fallbackFile}')`);

  await run(`CREATE OR REPLACE TABLE packing_events AS SELECT e.* FROM events_flagged e WHERE e.txn_type = 'Packing'`);

  await run(`
    CREATE OR REPLACE TABLE packing_scored AS
    SELECT
      p.*,
      CASE WHEN b.usable THEN 'signature' ELSE 'brand_fallback' END AS bench_tier,
      COALESCE(CASE WHEN b.usable THEN b.spread_p25 END, f.p25) AS bench_p25,
      COALESCE(CASE WHEN b.usable THEN b.benchmark_p50_line_duration_min * b.lines_per_order END, f.p50) AS bench_p50,
      COALESCE(CASE WHEN b.usable THEN b.spread_p75 END, f.p75) AS bench_p75,
      COALESCE(CASE WHEN b.usable THEN b.benchmark_trimmed_mean_line_duration_min * b.lines_per_order END, f.trimmed) AS bench_trimmed
    FROM packing_events p
    LEFT JOIN benchmark_signature b ON b.client = p.client AND b.signature = p.signature
    LEFT JOIN brand_fallback f ON f.client = p.client
  `);

  await run(`
    CREATE OR REPLACE TABLE curated_packing_line AS
    SELECT
      r.order_code,
      p.event_time,
      r.sku,
      row_number() OVER (PARTITION BY r.order_code, p.event_time, r.sku ORDER BY r.raw_row_id) AS line_seq,
      p.packer_login,
      p.client,
      p.work_date::DATE AS work_date,
      extract(hour FROM p.event_time)::INT AS hour_of_day,
      p.signature,
      p.n_lines,
      r.pack_qty,
      r.uom_qty,
      p.order_duration_min,
      CASE WHEN p.n_lines > 0 THEN p.order_duration_min / p.n_lines ELSE NULL END AS line_duration_min,
      p.raw_gap_min,
      p.duration_flag,
      p.next_action_type,
      p.target_location,
      p.order_type,
      p.bench_tier, p.bench_p25, p.bench_p50, p.bench_p75, p.bench_trimmed
    FROM raw r
    JOIN packing_scored p
      ON r.order_code = p.order_code
     AND r.packer_login = p.packer_login
     AND r.event_time = p.event_time
     AND r.txn_type = 'Packing'
  `);

  const [{ n: curatedCount }] = await run(`SELECT count(*) AS n FROM curated_packing_line`);
  log(`  ${curatedCount} curated packing lines ready`);

  log("Loading reference tables (SKU map, name map, attendance)…");
  await run(`CREATE OR REPLACE TABLE sku_product_mapping AS SELECT * FROM read_csv_auto('${inputs.skuMapFile}')`);
  await run(`CREATE OR REPLACE TABLE name_wms_mapping AS SELECT * FROM read_csv_auto('${inputs.nameMapFile}')`);

  // Real schema confirmed against April.csv: "Employee ID", "Employer",
  // "Shift Name", "Sign In Time" / "Sign Out Time" / "Shift Start Time" /
  // "Shift End Time" as "Apr 30, 2026, 8:19 PM"-style strings, "Delay
  // (mins)", "Normal Hours", "Overtime Hours". work_date is derived from
  // Shift Start Time's date, matching the "shift's calendar date, as
  // exported" contract in sql/schema.sql. Deduped per (employee_id,
  // work_date, shift_name), keeping the latest sign-in if a person was
  // re-exported across overlapping files.
  await run(`
    CREATE OR REPLACE TABLE attendance_raw AS
    SELECT
      "Employee ID" AS employee_id,
      "Employer" AS employer,
      "Shift Name" AS shift_name,
      strptime("Sign In Time", '%b %d, %Y, %I:%M %p') AS sign_in_time,
      strptime("Sign Out Time", '%b %d, %Y, %I:%M %p') AS sign_out_time,
      strptime("Shift Start Time", '%b %d, %Y, %I:%M %p') AS shift_start_time,
      strptime("Shift End Time", '%b %d, %Y, %I:%M %p') AS shift_end_time,
      TRY_CAST(REPLACE("Delay (mins)", '"', '') AS DOUBLE) AS delay_mins,
      TRY_CAST("Normal Hours" AS DOUBLE) AS normal_hours,
      TRY_CAST("Overtime Hours" AS DOUBLE) AS overtime_hours,
      date_trunc('day', strptime("Shift Start Time", '%b %d, %Y, %I:%M %p'))::DATE AS work_date
    FROM read_csv_auto('${attDir}/*.csv', union_by_name=true)
    QUALIFY row_number() OVER (
      PARTITION BY "Employee ID", work_date, "Shift Name" ORDER BY sign_in_time DESC
    ) = 1
  `);
  const [{ n: attCount }] = await run(`SELECT count(*) AS n FROM attendance_raw`);
  log(`  ${attCount} attendance rows ready`);

  log("Attaching Supabase Postgres and writing results…");
  await run(`INSTALL postgres; LOAD postgres;`);
  await run(`ATTACH '${inputs.databaseUrl}' AS pg (TYPE POSTGRES)`);

  await run(`DELETE FROM pg.curated_packing WHERE work_date IN (SELECT DISTINCT work_date FROM curated_packing_line)`);
  await run(`
    INSERT INTO pg.curated_packing
    SELECT order_code, event_time, sku, line_seq, packer_login, client, work_date, hour_of_day,
           signature, n_lines, pack_qty, uom_qty, order_duration_min, line_duration_min,
           raw_gap_min, duration_flag, next_action_type, target_location, order_type,
           bench_tier, bench_p25, bench_p50, bench_p75, bench_trimmed
    FROM curated_packing_line
  `);

  await run(`DELETE FROM pg.attendance WHERE work_date IN (SELECT DISTINCT work_date FROM attendance_raw)`);
  await run(`
    INSERT INTO pg.attendance
    SELECT employee_id, work_date, employer, shift_name, sign_in_time, sign_out_time,
           shift_start_time, shift_end_time, delay_mins, normal_hours, overtime_hours
    FROM attendance_raw
  `);

  await run(`DELETE FROM pg.sku_product_mapping`);
  await run(`INSERT INTO pg.sku_product_mapping SELECT "Product SKU", "Client", "Product Name", now() FROM sku_product_mapping`);

  await run(`DELETE FROM pg.name_wms_mapping`);
  await run(`
    INSERT INTO pg.name_wms_mapping
    SELECT employee_id, employee_name, agency, transaction_user_login, match_status,
           COALESCE(mixed_security_signal = 'yes', false), now()
    FROM name_wms_mapping
  `);

  log("Done. curated_packing, attendance, sku_product_mapping, name_wms_mapping refreshed in Supabase.");
  return { rawRows: Number(rawCount), curatedRows: Number(curatedCount) };
}
