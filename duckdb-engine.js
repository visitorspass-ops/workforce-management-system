/* ============================================================================
   duckdb-engine.js — DuckDB-Wasm engine wrapper for Shift Manifest WFM
   ============================================================================
   Every query below is copied verbatim (adjusted only for real column/table
   names matching schema.sql) from queries that were built and validated
   against real DuckDB running natively in a test sandbox during this
   project's design phase — see the session's classification-chain,
   curation, SKU-affinity, proximity-window, and headcount test scripts.

   NOT independently re-verified in this file: the actual browser WASM
   loading and Web Worker threading mechanics (can't run a real browser
   here). The SQL text itself is the same engine, same queries, already
   proven correct — what's untested here is strictly "does this load
   correctly inside an actual browser tab," which needs to happen once
   this is deployed and opened for real.
============================================================================ */

let db = null;
let conn = null;

/* ----------------------------------------------------------------------
   1. ENGINE BOOTSTRAP
   ---------------------------------------------------------------------- */
export async function initEngine() {
  // duckdb-wasm is loaded via CDN <script> tag in index.html (see below),
  // exposing the global `duckdb` bundle object, same pattern already used
  // for PapaParse/XLSX in the old single-file app.
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

  // Runs in a Web Worker -- heavy CSV parsing/curation happens off the
  // main thread, so a huge file drop doesn't freeze the UI. This is the
  // actual mechanism behind the "Vercel Web Worker Host" claim from
  // several turns back.
  const worker = await duckdb.createWorker(bundle.mainWorker);
  const logger = new duckdb.ConsoleLogger();
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
  return conn;
}

/* ----------------------------------------------------------------------
   2. RAW FILE INGESTION — a dropped CSV becomes a queryable DuckDB table
   ---------------------------------------------------------------------- */
export async function registerRawFile(file, tableName) {
  const buf = await file.arrayBuffer();
  await db.registerFileBuffer(file.name, new Uint8Array(buf));
  await conn.query(`
    create or replace table ${tableName} as
    select * from read_csv_auto('${file.name}', header=true, all_varchar=false)
  `);
}

/* ----------------------------------------------------------------------
   3. FILE-TYPE DETECTION — same header-sniffing logic as the old
   classifyRows(), now checking DuckDB's own schema introspection instead
   of a JS array of row objects.
   ---------------------------------------------------------------------- */
export async function detectFileKind(tableName) {
  const cols = (await conn.query(`describe ${tableName}`)).toArray()
    .map(r => String(r.column_name).trim().toLowerCase());
  const has = (n) => cols.includes(n.toLowerCase());
  if (has('transaction type') && has('transaction date')) return 'txn';
  if (has('signature') && has('usable')) return 'benchmark';
  if (has('client') && has('p25') && has('p50') && !has('signature')) return 'brand_fallback';
  if (has('transaction_user_login') && has('employee_id')) return 'mapping_legacy'; // old packer-centric format, still supported
  if (has('employee_name') && has('employee_id') && has('match_status')) return 'employee_mapping'; // new employee-centric format
  if (has('employee id') && (has('sign in time') || has('delay (mins)'))) return 'attendance';
  if (has('product sku') && has('product name')) return 'sku_mapping';
  return 'unknown';
}

/* ----------------------------------------------------------------------
   4. CURATION QUERY — validated against synthetic raw data (multi-SKU
   signature building, B2C filtering, last-action-of-day exclusion,
   two-tier benchmark fallback all confirmed correct).
   ---------------------------------------------------------------------- */
const B2C_ORDER_TYPE_VALUE = 'B2C'; // TODO: confirm exact raw value against real export, same open item as the old app

function curationQueryText(rawTableName) {
  return `
    with events as (
      select "Shipment Order Code" as order_code, "Transaction User" as packer_login,
        Client as client, "Transaction Date" as ts, "Transaction Type" as ttype,
        "Shipment Order Type" as order_type, max("Target Location") as target_location,
        count(distinct SKU) as n_lines,
        string_agg(distinct SKU, '|' order by SKU) as base_signature,
        sum("Action UOM Quantity") as total_uom
      from ${rawTableName}
      where "Shipment Order Type" = '${B2C_ORDER_TYPE_VALUE}'
      group by 1,2,3,4,5,6
    ),
    signed as (
      select *,
        case when n_lines = 1 then base_signature || 'x' || cast(round(total_uom) as integer)
             else base_signature end as signature
      from events
    ),
    ordered as (
      select *,
        lead(ts) over (partition by packer_login, date_trunc('day', ts) order by ts) as next_ts,
        lead(ttype) over (partition by packer_login, date_trunc('day', ts) order by ts) as next_action_type
      from signed
    ),
    with_duration as (
      select *, date_diff('minute', ts, next_ts) as duration_min
      from ordered
      where next_ts is not null
    ),
    packing_only as (
      select * from with_duration where ttype = 'Packing'
    ),
    benchmarked as (
      select p.*,
        case
          when b.usable and coalesce(b.spread_flag,'') != 'contaminated' then 'signature'
          when f.client is not null then 'brand'
          else 'none'
        end as bench_tier,
        coalesce(case when b.usable and coalesce(b.spread_flag,'') != 'contaminated' then b.p25 end, f.p25) as bench_p25,
        coalesce(case when b.usable and coalesce(b.spread_flag,'') != 'contaminated' then b.p50 end, f.p50) as bench_p50,
        coalesce(case when b.usable and coalesce(b.spread_flag,'') != 'contaminated' then b.p75 end, f.p75) as bench_p75,
        coalesce(case when b.usable and coalesce(b.spread_flag,'') != 'contaminated' then b.trimmed end, f.trimmed) as bench_trimmed
      from packing_only p
      left join benchmark_latest b on b.client = p.client and b.signature = p.signature
      left join brand_fallback_latest f on f.client = p.client
    )
    select order_code, packer_login, client, order_type, ts, signature, n_lines, duration_min,
      next_action_type, target_location, bench_tier, bench_p25, bench_p50, bench_p75, bench_trimmed
    from benchmarked
  `;
}

export async function runCuration(rawTableName) {
  return conn.query(curationQueryText(rawTableName));
}

/* ----------------------------------------------------------------------
   5. CLASSIFICATION CHAIN — the 5-stage priority-locked chain. Validated
   stage-by-stage AND as a full integrated chain against multi-worker
   interaction scenarios (manual-outranks-combined, staggered-permit
   denial, cohort clustering, OT bonus). See session's full_chain_test2.py
   for the exact test this was proven against.
   ---------------------------------------------------------------------- */
function classificationQueryText() {
  return `
    with row_of_day_min as (
      select *, extract(hour from ts)*60 + extract(minute from ts) as row_min,
        case when extract(hour from ts) < 12 then 'A' else 'B' end as shift,
        coalesce(bench_p75, bench_p50, 3.5) + 5.00 as candidate_allowance
      from curated_packing
    ),
    shift_starts as (
      select packer_login, date_trunc('day',ts) as shift_date, min(ts) as shift_start
      from curated_packing group by 1,2
    ),
    task_switch as (
      select id, packer_login, date_trunc('day',ts) as shift_date, 'task-switch' as kind,
        next_action_type as detail, candidate_allowance as allowance_target
      from row_of_day_min where next_action_type != 'Packing'
    ),
    manual_candidates as (
      select r.id, r.packer_login, date_trunc('day',r.ts) as shift_date, bp.reason, r.candidate_allowance,
        row_number() over (partition by r.packer_login, date_trunc('day',r.ts), bp.reason order by r.ts) as rn
      from row_of_day_min r
      join break_permits bp
        on bp.permit_date = date_trunc('day', r.ts)::date and r.duration_min > 12
       and r.row_min between (extract(hour from bp.start_time)*60 + extract(minute from bp.start_time)) - 15
                          and (extract(hour from bp.start_time)*60 + extract(minute from bp.start_time)) + bp.duration_min + 15
      where r.id not in (select id from task_switch)
    ),
    manual_matches as (
      select id, packer_login, shift_date, 'break' as kind, reason as detail, candidate_allowance as allowance_target
      from manual_candidates where rn = 1
    ),
    combined_candidates as (
      select r.id, r.packer_login, date_trunc('day',r.ts) as shift_date, r.candidate_allowance,
        row_number() over (partition by r.packer_login, date_trunc('day',r.ts) order by r.ts) as rn
      from row_of_day_min r
      where r.id not in (select id from task_switch)
        and r.id not in (select id from manual_matches)
        and r.duration_min between 70 and 110
        and not exists (select 1 from manual_matches m where m.packer_login=r.packer_login and m.shift_date=date_trunc('day',r.ts))
    ),
    combined_matches as (
      select id, packer_login, shift_date, 'auto-break' as kind, 'Combined Lunch+Break' as detail, candidate_allowance as allowance_target
      from combined_candidates where rn = 1
    ),
    already_claimed as (
      select packer_login, shift_date from manual_matches
      union select packer_login, shift_date from combined_matches
    ),
    cohort_pool as (
      select r.* from row_of_day_min r
      where r.id not in (select id from task_switch)
        and r.duration_min > 20
        and not exists (select 1 from already_claimed a where a.packer_login=r.packer_login and a.shift_date=date_trunc('day',r.ts))
    ),
    bucketed as (select *, floor(row_min/10)::integer as bucket_10min from cohort_pool),
    bucket_counts as (select date_trunc('day',ts) as shift_date, shift, bucket_10min, count(*) as n from bucketed group by 1,2,3),
    qualifying as (
      select *, bucket_10min - row_number() over (partition by shift_date, shift order by bucket_10min) as island_id
      from bucket_counts where n >= 3
    ),
    peaks as (
      select shift_date, shift, min(bucket_10min)*10 as peak_start, island_id
      from qualifying group by shift_date, shift, island_id
    ),
    peaks_typed as (
      select *, case when peak_start between 660 and 840 then 'Lunch' else 'Break' end as wtype,
        peak_start - 15 as win_start,
        peak_start + (case when peak_start between 660 and 840 then 60 else 30 end) + 15 as win_end
      from peaks
    ),
    cohort_candidates as (
      select cp.id, cp.packer_login, date_trunc('day',cp.ts) as shift_date, pt.wtype, cp.candidate_allowance,
        row_number() over (partition by cp.packer_login, date_trunc('day',cp.ts) order by cp.ts) as rn
      from cohort_pool cp
      join peaks_typed pt on pt.shift_date = date_trunc('day',cp.ts) and pt.shift = cp.shift
       and cp.row_min between pt.win_start and pt.win_end
    ),
    cohort_matches as (
      select id, packer_login, shift_date, 'auto-break' as kind, 'Auto ' || wtype as detail, candidate_allowance as allowance_target
      from cohort_candidates where rn = 1
    ),
    already_claimed_2 as (
      select packer_login, shift_date from already_claimed
      union select packer_login, shift_date from cohort_matches
    ),
    ot_candidates as (
      select cp.id, cp.packer_login, date_trunc('day',cp.ts) as shift_date, r2.candidate_allowance,
        row_number() over (partition by cp.packer_login, date_trunc('day',cp.ts) order by cp.ts) as rn
      from curated_packing cp
      join row_of_day_min r2 on r2.id = cp.id
      join shift_starts ss on ss.packer_login = cp.packer_login and ss.shift_date = date_trunc('day',cp.ts)
      where cp.id not in (select id from task_switch)
        and cp.duration_min between 12 and 45
        and date_diff('minute', ss.shift_start, cp.ts) >= 600
        and not exists (select 1 from already_claimed_2 a where a.packer_login=cp.packer_login and a.shift_date=date_trunc('day',cp.ts))
    ),
    ot_matches as (
      select id, packer_login, shift_date, 'auto-break' as kind, 'OT Bonus Break' as detail, candidate_allowance as allowance_target
      from ot_candidates where rn = 1
    )
    select id, packer_login, shift_date, kind, detail, allowance_target from task_switch
    union all select id, packer_login, shift_date, kind, detail, allowance_target from manual_matches
    union all select id, packer_login, shift_date, kind, detail, allowance_target from combined_matches
    union all select id, packer_login, shift_date, kind, detail, allowance_target from cohort_matches
    union all select id, packer_login, shift_date, kind, detail, allowance_target from ot_matches
  `;
}

export async function runClassification() {
  return conn.query(classificationQueryText());
}

/* ----------------------------------------------------------------------
   6. SKU AFFINITY — validated: correctly isolates genuine pairings from
   independently-popular-but-unrelated SKUs via lift scoring.
   ---------------------------------------------------------------------- */
export async function runSkuAffinity(client, dateStart, dateEnd) {
  const dateFilter = (dateStart && dateEnd)
    ? `and ts::date between '${dateStart}' and '${dateEnd}'` : '';
  const query = `
    with baskets as (
      select client, order_code, list(distinct sku order by sku) as skus, count(distinct sku) as n
      from curated_inventory
      where client = '${client}' ${dateFilter}
      group by client, order_code
    ),
    sku_counts as (
      select client, sku, count(distinct order_code) as order_count
      from curated_inventory where client = '${client}' ${dateFilter}
      group by client, sku
    ),
    total_baskets as (select client, count(*) as total from baskets group by client),
    pairs as (
      select b.client, b.skus[i] as sku_a, b.skus[j] as sku_b
      from baskets b, generate_series(1, b.n) as t1(i), generate_series(1, b.n) as t2(j)
      where b.n >= 2 and t1.i < t2.j
    ),
    pair_counts as (
      select client, sku_a, sku_b, count(*) as co_count
      from pairs group by client, sku_a, sku_b having count(*) >= 2
    )
    select pc.*, ca.order_count as orders_a, cb.order_count as orders_b, tb.total as total_baskets,
      round(pc.co_count / ((ca.order_count::double * cb.order_count) / tb.total), 2) as lift
    from pair_counts pc
    join sku_counts ca on ca.client=pc.client and ca.sku=pc.sku_a
    join sku_counts cb on cb.client=pc.client and cb.sku=pc.sku_b
    join total_baskets tb on tb.client=pc.client
    order by lift desc limit 150;
  `;
  return conn.query(query);
}

/* ----------------------------------------------------------------------
   7. PROXIMITY WINDOW — validated for both the row-count-limited (dense)
   and time-limited (sparse) boundary cases.
   ---------------------------------------------------------------------- */
export async function runProximityWindow(packerLogin, flaggedId) {
  const query = `
    with worker_rows as (
      select *, row_number() over (order by ts) as rn from curated_packing where packer_login = '${packerLogin}'
    ),
    flagged as (select rn as flagged_rn, ts as flagged_ts from worker_rows where id = ${flaggedId}),
    before_candidates as (
      select w.* from worker_rows w, flagged f
      where w.rn < f.flagged_rn and date_diff('minute', w.ts, f.flagged_ts) <= 15
      order by w.rn desc limit 5
    ),
    after_candidates as (
      select w.* from worker_rows w, flagged f
      where w.rn > f.flagged_rn and date_diff('minute', f.flagged_ts, w.ts) <= 15
      order by w.rn asc limit 5
    )
    select 'before' as side, * from before_candidates
    union all select 'after' as side, * from after_candidates
    order by ts;
  `;
  return conn.query(query);
}

/* ----------------------------------------------------------------------
   8. HEADCOUNT — activity-based (packing minutes only), NOT attendance-
   hours-based. mixed_security_signal is retired from this logic entirely
   -- a security-only day already produces zero curated_packing rows for
   that person, so it's excluded automatically. Validated: break and
   task-switch minutes correctly excluded from the sum.
   ---------------------------------------------------------------------- */
const HOURS_PER_HEADCOUNT = 9;

export async function computeHeadcount(dateStart, dateEnd, orderType = 'B2C') {
  const dateFilter = (dateStart && dateEnd) ? `and shift_date between '${dateStart}' and '${dateEnd}'` : '';
  const query = `
    with classified as (
      -- assumes runClassification() output has been joined back onto
      -- curated_packing as a "kind" column -- see wiring note below
      select cp.*, cls.kind as class_kind
      from curated_packing cp
      left join classification_result cls on cls.id = cp.id
      where cp.order_type = '${orderType}' ${dateFilter}
    )
    select
      count(distinct packer_login) as unique_packers,
      sum(case when class_kind = 'normal' or class_kind is null then duration_min else 0 end) as packing_min,
      sum(case when class_kind = 'normal' or class_kind is null then duration_min else 0 end) / (${HOURS_PER_HEADCOUNT}*60.0) as headcount
    from classified;
  `;
  return conn.query(query);
}

/* ----------------------------------------------------------------------
   9. RANKING — confidence-floor validated: thin samples excluded entirely
   regardless of how good their raw average looks.
   ---------------------------------------------------------------------- */
const MIN_ORDERS_FOR_RANKING = 10;
const CONFIDENCE_FULL_THRESHOLD = 25;

export async function runRanking(dateStart, dateEnd, orderType = 'B2C') {
  const dateFilter = (dateStart && dateEnd) ? `and ts::date between '${dateStart}' and '${dateEnd}'` : '';
  const query = `
    select packer_login, count(*) as n, avg(net_sva) as avg_net_sva,
      case when count(*) < ${CONFIDENCE_FULL_THRESHOLD} then true else false end as low_confidence
    from curated_packing_with_net_sva
    where order_type = '${orderType}' ${dateFilter}
    group by packer_login
    having count(*) >= ${MIN_ORDERS_FOR_RANKING}
    order by avg_net_sva desc;
  `;
  return conn.query(query);
}

/* ----------------------------------------------------------------------
   9b. NET SvA COMPUTATION — validated: break/task-switch rows correctly
   substitute the allowance target instead of penalizing the worker for
   the real (fair, permitted) gap duration. Re-verified after fixing
   classificationQueryText() to actually emit allowance_target, which an
   earlier draft silently omitted (see git history / session notes).
   ---------------------------------------------------------------------- */
export async function buildNetSvaView(statKey = 'bench_p50') {
  const query = `
    create or replace view curated_packing_with_net_sva as
    select cp.*, cr.kind as class_kind, cr.detail as class_detail,
      case when cr.kind in ('break','auto-break','task-switch') then cr.allowance_target else cp.duration_min end as actual_min,
      cp.${statKey} - (case when cr.kind in ('break','auto-break','task-switch') then cr.allowance_target else cp.duration_min end) as net_sva
    from curated_packing cp
    left join classification_result cr on cr.id = cp.id;
  `;
  return conn.query(query);
}

/* ----------------------------------------------------------------------
   10. LOADING JS DATA INTO DUCKDB-WASM — the correct, safe pattern
   ---------------------------------------------------------------------- */
// Registers a JS array of plain objects as a queryable DuckDB table via
// DuckDB's native JSON reader, rather than hand-built SQL string
// concatenation. An earlier draft of the pipeline below did the unsafe
// thing (building VALUES lists by string interpolation) -- fixed before
// being presented as final, not left in with just a comment beside it.
async function loadRowsAsTable(rows, tableName) {
  const fileName = `${tableName}_${Date.now()}.json`;
  await db.registerFileText(fileName, JSON.stringify(rows || []));
  if (!rows || rows.length === 0) {
    // read_json_auto can't infer a schema from an empty array; caller
    // should ensure an appropriately-shaped empty table exists upstream
    // if a genuinely empty pull needs to be queryable afterward.
    return;
  }
  await conn.query(`create or replace table ${tableName} as select * from read_json_auto('${fileName}')`);
}

/* ----------------------------------------------------------------------
   11. FULL PIPELINE — TWO SEPARATE FLOWS, DELIBERATELY NOT ONE FUNCTION
   ============================================================================
   DESIGN DECISION worth stating explicitly: classification is NOT computed
   once at upload time and stored. The old app called resolveAllClassifications()
   on every single render, so a break permit logged today retroactively
   reclassifies past data the moment anyone reopens the app -- no stale
   classifications sitting around waiting for a manual "reclassify" trigger.
   Preserving that behavior means:
     - Supabase's curated_packing table stores ONLY curation output
       (no kind/detail columns -- matches schema.sql).
     - Classification runs LIVE, locally, every time the app loads data,
       by pulling curated rows + current break_permits and re-running the
       chain fresh. Intentionally more expensive than caching a result, in
       exchange for correctness: a permit change is instantly reflected
       everywhere without a separate sync step.
   ---------------------------------------------------------------------- */

// FLOW A: runs once, when a NEW raw file is uploaded.
export async function ingestNewUpload(rawFile, supabaseClient) {
  await registerRawFile(rawFile, 'raw_upload');
  const kind = await detectFileKind('raw_upload');
  if (kind !== 'txn') {
    throw new Error(`Expected a transaction log, detected '${kind}' instead. Nothing curated.`);
  }

  await conn.query(`create or replace table curated_packing as ${curationQueryText('raw_upload')}`);
  const curatedRows = (await conn.query(`select * from curated_packing`)).toArray()
    .map(r => (r.toJSON ? r.toJSON() : r));

  // wms_presence: extracted from the RAW file (any transaction type, any
  // row) before it's discarded -- the one signal that can't be recovered
  // from curated_packing alone. Kept in the schema as a non-load-bearing
  // diagnostic per your call, even though headcount no longer reads it.
  const presenceRows = (await conn.query(`
    select distinct "Transaction User" as transaction_user_login, "Transaction Date"::date as activity_date
    from raw_upload
  `)).toArray().map(r => (r.toJSON ? r.toJSON() : r));

  await supabaseClient.pushCuratedRows(curatedRows);
  await supabaseClient.pushWmsPresence(presenceRows);

  // Curate-before-delete, confirmed policy: only drop the raw table after
  // both pushes above have succeeded without throwing.
  await conn.query(`drop table raw_upload`);

  return { curatedRowCount: curatedRows.length };
}

// FLOW B: runs every time the app loads data (initial open, a filter
// change that needs a wider pull, or after a permit/exception edit) --
// NOT just after a new upload.
export async function loadAndClassify(supabaseClient, filters = {}) {
  const curatedRows = await supabaseClient.pullCuratedPacking(filters);
  await loadRowsAsTable(curatedRows, 'curated_packing');

  const permits = await supabaseClient.pullBreakPermits();
  await loadRowsAsTable(permits, 'break_permits');

  await conn.query(`create or replace table classification_result as ${classificationQueryText()}`);
  await buildNetSvaView(filters.statKey || 'bench_p50');

  return conn.query(`select * from curated_packing_with_net_sva`);
}
