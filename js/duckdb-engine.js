/* ============================================================================
   duckdb-engine.js — DuckDB-Wasm engine wrapper for Shift Manifest WFM
   ============================================================================
   Every query below is copied verbatim (adjusted only for real column/table
   names matching schema.sql) from queries built and validated against real
   DuckDB running natively in a test sandbox during this project's design
   phase — see the session's classification-chain, curation, SKU-affinity,
   proximity-window, and headcount test scripts.

   CORRECTION, added after the first real deploy: initEngine() below was
   wrong in two ways, caught by an actual "duckdb is not defined" +
   "Cannot read properties of null (reading 'registerFileBuffer')" error
   pair once this was deployed for real:
     1. It assumed a <script src="..."> tag would expose a global `duckdb`
        object. DuckDB-Wasm is distributed as an ES module and doesn't work
        that way — it has to be `import`ed, which is what the line below
        does now.
     2. It called `duckdb.createWorker(...)`, a method that does not exist
        in the real API — fabricated, not verified against DuckDB's actual
        documentation before being written the first time. Fixed to match
        the real, documented worker-construction pattern (Blob +
        importScripts), checked against DuckDB's current official docs
        before being applied here, not guessed a second time.
============================================================================ */
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';

let db = null;
let conn = null;

/* ----------------------------------------------------------------------
   1. ENGINE BOOTSTRAP
   ---------------------------------------------------------------------- */
export async function initEngine() {
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

  // Runs in a Web Worker -- heavy CSV parsing/curation happens off the
  // main thread, so a huge file drop doesn't freeze the UI. Real,
  // documented construction pattern: wrap the worker script in a Blob so
  // it can be loaded as a same-origin Worker regardless of the CDN's
  // cross-origin restrictions.
  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(worker_url);
  const logger = new duckdb.ConsoleLogger();
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(worker_url);
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
  if ((has('brand') || has('client')) && (has('trimmed') || has('trimmed mean'))
      && (has('p75') || has('p75 order duration') || has('p50') || has('p50 order duration'))
      && !has('signature')) return 'brand_fallback';
  if (has('employee_name') && has('employee_id') && has('match_status')) return 'employee_mapping'; // new employee-centric format -- checked BEFORE the legacy check below, since a file can satisfy both and the more specific/newer format should win
  if (has('transaction_user_login') && has('employee_id')) return 'mapping_legacy'; // old packer-centric format, still supported
  if (has('employee id') && (has('sign in time') || has('delay (mins)'))) return 'attendance';
  if (has('product sku') && has('product name')) return 'sku_mapping';
  return 'unknown';
}

/* Cheap rename -- NOT a re-parse. Lets multiple already-registered raw
   files be held under distinct names (for up-front kind detection and
   priority sorting) and then handed to whichever ingestX function
   matches, all under the one table name ('raw_upload') those functions
   expect, without ever reading the CSV a second time. */
export async function renameRawTable(fromName, toName) {
  await conn.query(`alter table ${fromName} rename to ${toName}`);
}

/* ----------------------------------------------------------------------
   4. CURATION QUERY — validated against synthetic raw data (multi-SKU
   signature building, B2C filtering, last-action-of-day exclusion all
   confirmed correct against the real Python pipeline's output).

   CHANGED (migration 001): no longer joins a benchmark at all. Benchmark
   resolution moved to QUERY TIME (see resolveBenchmarks() below) so that
   reassigning a date range to a different labeled version never requires
   touching an already-curated row -- curated_packing is facts only now:
   order_code, packer_login, client, ts, signature, duration_min, etc.
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
    )
    select order_code, packer_login, client, order_type,
      strftime(ts, '%Y-%m-%d %H:%M:%S') as ts, -- explicit ISO string, NOT raw TIMESTAMP -- see
      -- note in ingestAttendance for why: DuckDB-Wasm serializes a raw
      -- TIMESTAMP to JS as epoch-milliseconds, which Postgres's ::timestamptz
      -- cast then fails to parse (confirmed by a real failure on the
      -- structurally identical sign_in/sign_out columns). Formatting here
      -- guarantees a Postgres-parseable string regardless of Arrow's
      -- internal representation.
      signature, n_lines, duration_min,
      next_action_type, target_location
    from packing_only
  `;
}

export async function runCuration(rawTableName) {
  return conn.query(curationQueryText(rawTableName));
}

/* ----------------------------------------------------------------------
   4b. QUERY-TIME BENCHMARK RESOLUTION — replaces the old baked-in join.
   Runs live on every load, same pattern as classification. Resolves each
   curated row's date -> version_assignments -> effective_label -> the
   benchmark_versions/brand_fallback_benchmark row carrying that label.

   OVERLAP HANDLING: if two version_assignments rows both cover the same
   date (not prevented by a DB constraint -- see migration_001.sql note),
   this takes the most-recently-CREATED assignment, not the narrowest or
   earliest date range. Flagged, not silently chosen -- an exclusion
   constraint would prevent the ambiguity outright if you'd rather that.
   ---------------------------------------------------------------------- */
function benchmarkResolutionQueryText() {
  return `
    with resolved_label as (
      select cp.id as curated_id,
        (select va.effective_label from version_assignments va
         where date_trunc('day', cp.ts) between va.start_date and va.end_date
         order by va.created_at desc limit 1) as effective_label
      from curated_packing cp
    ),
    benchmarked as (
      select cp.*, rl.effective_label,
        case
          when b.usable and coalesce(b.spread_flag,'') != 'contaminated' then 'signature'
          when f.client is not null then 'brand'
          else 'none'
        end as bench_tier,
        coalesce(case when b.usable and coalesce(b.spread_flag,'') != 'contaminated' then b.p25 end, f.p25) as bench_p25,
        coalesce(case when b.usable and coalesce(b.spread_flag,'') != 'contaminated' then b.p50 end, f.p50) as bench_p50,
        coalesce(case when b.usable and coalesce(b.spread_flag,'') != 'contaminated' then b.p75 end, f.p75) as bench_p75,
        coalesce(case when b.usable and coalesce(b.spread_flag,'') != 'contaminated' then b.trimmed end, f.trimmed) as bench_trimmed
      from curated_packing cp
      join resolved_label rl on rl.curated_id = cp.id
      left join benchmark_versions b
        on b.client = cp.client and b.signature = cp.signature and b.effective_label = rl.effective_label
      left join brand_fallback_benchmark f
        on f.client = cp.client and f.effective_label = rl.effective_label
    )
    select * from benchmarked
  `;
}

export async function resolveBenchmarks() {
  return conn.query(`create or replace view curated_packing_benchmarked as ${benchmarkResolutionQueryText()}`);
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
      -- reads from curated_packing_benchmarked (the query-time resolved view),
      -- not curated_packing directly -- bench_p75/p50 no longer live on the
      -- base table since migration 001.
      select *, extract(hour from ts)*60 + extract(minute from ts) as row_min,
        case when extract(hour from ts) < 12 then 'A' else 'B' end as shift,
        coalesce(bench_p75, bench_p50, 3.5) + 5.00 as candidate_allowance
      from curated_packing_benchmarked
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
  // Reads from curated_packing_benchmarked, not curated_packing -- the
  // stat columns (bench_p25/p50/p75/trimmed) only exist on the resolved
  // view since migration 001. Call resolveBenchmarks() before this.
  const query = `
    create or replace view curated_packing_with_net_sva as
    select cp.*, cr.kind as class_kind, cr.detail as class_detail,
      case when cr.kind in ('break','auto-break','task-switch') then cr.allowance_target else cp.duration_min end as actual_min,
      cp.${statKey} - (case when cr.kind in ('break','auto-break','task-switch') then cr.allowance_target else cp.duration_min end) as net_sva
    from curated_packing_benchmarked cp
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

// FLOW A: runs once, when a NEW raw file is uploaded. TRANSACTION LOG only
// -- see ingestBenchmark/ingestBrandFallback/ingestAttendance/
// ingestEmployeeMapping/ingestSkuMapping below for the other four file
// types the upload gate accepts. An earlier version of this pipeline only
// had this one function, and the upload handler called it on every file
// regardless of type -- caught on first real multi-file upload ("Expected
// a transaction log, detected 'attendance' instead"). Fixed by building
// the other four handlers and dispatching by detected kind in index.html.
// REMOVED (migration 001): ensureLocalBenchmarkTables() used to pull
// benchmark_latest/brand_fallback_latest and join them into curation.
// Curation no longer resolves a benchmark at all -- see curationQueryText
// above -- so this function is dead code and has been deleted rather than
// left as an unused alternate path. Benchmark resolution now happens in
// loadAndClassify() via resolveBenchmarks(), against version_assignments.

/* All six ingestX functions below now assume 'raw_upload' has ALREADY been
   registered and kind-detected by the CALLER, exactly once. An earlier
   version had each function re-register and re-parse the file itself,
   on top of a "peek" registration the upload handler already did to
   figure out which function to call in the first place -- meaning every
   file, including the largest one (the transaction log), got fully
   CSV-parsed TWICE. Reported as the page becoming unresponsive on a real
   multi-file upload; fixed by having index.html register+detect once and
   pass nothing else, with every ingest function operating directly on the
   already-registered table. */

export async function ingestNewUpload(supabaseClient, onStage) {
  const stage = onStage || (() => {});
  // No more ensureLocalBenchmarkTables() call -- curation produces facts
  // only now, no benchmark join at curation time (see curationQueryText).
  stage({ label: 'Curating rows (grouping into orders, computing durations)...' });
  await conn.query(`create or replace table curated_packing_local as ${curationQueryText('raw_upload')}`);
  const curatedRows = (await conn.query(`select * from curated_packing_local`)).toArray()
    .map(r => (r.toJSON ? r.toJSON() : r));

  stage({ label: `Extracting presence records from ${curatedRows.length.toLocaleString()} curated rows...` });
  const presenceRows = (await conn.query(`
    select distinct "Transaction User" as transaction_user_login,
      strftime("Transaction Date"::date, '%Y-%m-%d') as activity_date
    from raw_upload
  `)).toArray().map(r => (r.toJSON ? r.toJSON() : r));

  // pushCuratedRows/pushWmsPresence now call the bulk_insert_* RPC
  // functions from migration_001.sql -- one round-trip per chunk instead
  // of one per 500-row REST insert. See supabase-client.js.
  await supabaseClient.pushCuratedRows(curatedRows, (p) => stage({
    label: `Pushing curated rows: ${p.rowsDone.toLocaleString()} / ${p.totalRows.toLocaleString()} (chunk ${p.chunksDone}/${p.totalChunks})`,
    fraction: p.chunksDone / p.totalChunks,
  }));
  await supabaseClient.pushWmsPresence(presenceRows, (p) => stage({
    label: `Pushing presence records: chunk ${p.chunksDone}/${p.totalChunks}`,
    fraction: p.chunksDone / p.totalChunks,
  }));
  await conn.query(`drop table raw_upload`);
  await conn.query(`drop table curated_packing_local`);

  return { curatedRowCount: curatedRows.length };
}

// Shared helper: transform the already-registered 'raw_upload' table via
// the given SQL, push via the given Supabase function, drop the raw table.
async function ingestGeneric(transformSql, pushFn, onStage) {
  const stage = onStage || (() => {});
  stage({ label: 'Reading and transforming rows...' });
  const rows = (await conn.query(transformSql)).toArray().map(r => (r.toJSON ? r.toJSON() : r));
  await pushFn(rows, (p) => stage({
    label: `Pushing: ${p.rowsDone.toLocaleString()} / ${p.totalRows.toLocaleString()} (chunk ${p.chunksDone}/${p.totalChunks})`,
    fraction: p.chunksDone / p.totalChunks,
  }));
  await conn.query(`drop table raw_upload`);
  return { rowCount: rows.length };
}

export async function ingestBenchmark(supabaseClient, onStage) {
  // Requires a "version" column in the file (e.g. "Q2 2026") -- your own
  // confirmed literal label, carried through as-is, not derived or defaulted.
  // Only "version" is accepted now, not "effective" -- you confirmed
  // "version" is the real standard, so a file missing it should fail loud
  // rather than silently matching a name it shouldn't.
  const cols = (await conn.query(`describe raw_upload`)).toArray().map(r => String(r.column_name));
  const effCol = cols.find(c => c.trim().toLowerCase() === 'version');
  if (!effCol) {
    throw new Error(`Benchmark file is missing the "version" column (found: ${cols.join(', ')}). Every benchmark upload needs a version label.`);
  }
  return ingestGeneric(`
    select client, signature, lines_per_order,
      spread_p25 as p25, benchmark_p50_line_duration_min as p50, spread_p75 as p75,
      benchmark_trimmed_mean_line_duration_min as trimmed,
      (usable::text = 'true') as usable, spread_flag,
      "${effCol}" as effective_label
    from raw_upload
  `, supabaseClient.pushBenchmarkVersion, onStage);
}

export async function ingestBrandFallback(supabaseClient, onStage) {
  // Real per-client p25/p50/p75/trimmed data, no shape_class bucketing --
  // confirmed. Header naming has ALREADY changed once between two real
  // exports of the same underlying data ("Brand"/"P75 Order Duration"/...
  // vs. "client"/"p75"/...) -- resolving columns dynamically by candidate
  // name here instead of assuming one fixed header set, so a third naming
  // variation doesn't silently break this again the same way.
  const cols = (await conn.query(`describe raw_upload`)).toArray().map(r => String(r.column_name));
  const findCol = (candidates) => cols.find(c => candidates.includes(c.trim().toLowerCase()));
  const clientCol = findCol(['brand', 'client']);
  const p25Col = findCol(['p25', 'p25 order duration']);
  const p50Col = findCol(['p50', 'p50 order duration']);
  const p75Col = findCol(['p75', 'p75 order duration']);
  const trimmedCol = findCol(['trimmed', 'trimmed mean']);
  const effCol = findCol(['version']);
  if (!clientCol || !p25Col || !p50Col || !p75Col || !trimmedCol) {
    throw new Error(`Brand fallback file is missing an expected column (found: ${cols.join(', ')})`);
  }
  if (!effCol) {
    throw new Error(`Brand fallback file is missing the "version" column (found: ${cols.join(', ')}). Every fallback upload needs a version label.`);
  }
  return ingestGeneric(`
    select "${clientCol}" as client, "${p25Col}" as p25, "${p50Col}" as p50,
      "${p75Col}" as p75, "${trimmedCol}" as trimmed, "${effCol}" as effective_label
    from raw_upload
  `, supabaseClient.pushBrandFallback, onStage);
}

export async function ingestAttendance(supabaseClient, onStage) {
  // Explicit strptime format, not an implicit ::timestamp cast -- the old
  // single-file app relied on the browser's own Date() leniency to parse
  // this exact "Apr 30, 2026, 8:19 PM" format, which was flagged as a real
  // cross-browser risk (Chrome is lenient about it, other engines aren't
  // guaranteed to be). DuckDB's strptime with an explicit format string
  // parses identically regardless of browser, closing that risk for free.
  //
  // CONFIRMED BUG, FIXED: sign_in/sign_out used to be selected as raw
  // strptime() TIMESTAMP values. DuckDB-Wasm serializes a TIMESTAMP to JS
  // as epoch-milliseconds (e.g. 1777580340000), and Postgres's
  // ::timestamptz cast in bulk_insert_attendance then fails trying to
  // parse that number-string as a date literal -- "date/time field value
  // out of range". Wrapping in strftime() forces an explicit ISO string
  // before the value ever leaves DuckDB, which Postgres parses correctly.
  return ingestGeneric(`
    select "Employee ID" as employee_id,
      strftime(strptime("Sign In Time", '%b %d, %Y, %I:%M %p')::date, '%Y-%m-%d') as shift_date,
      "Normal Hours" as normal_hours, "Overtime Hours" as overtime_hours,
      "Delay (mins)" as delay_mins,
      strftime(strptime("Sign In Time", '%b %d, %Y, %I:%M %p'), '%Y-%m-%d %H:%M:%S') as sign_in,
      strftime(strptime("Sign Out Time", '%b %d, %Y, %I:%M %p'), '%Y-%m-%d %H:%M:%S') as sign_out
    from raw_upload
  `, supabaseClient.pushAttendance, onStage);
}

export async function ingestEmployeeMapping(supabaseClient, onStage) {
  // NOTE: DuckDB's CSV auto-detection recognizes "yes"/blank in this
  // column as boolean-like data and converts it to a real boolean (true /
  // NULL) BEFORE this query ever runs -- confirmed by testing against the
  // real uploaded file. The original version here tried to string-compare
  // that already-boolean value against the literal text 'yes', which can
  // never match (a real `true` casts to the text 'true', not 'yes'),
  // silently marking every single employee as unflagged regardless of the
  // source data. Fixed to use the already-inferred boolean directly.
  return ingestGeneric(`
    select employee_name, employee_id, agency, transaction_user_login, match_status,
      coalesce(mixed_security_signal, false) as mixed_security_signal,
      name_variants
    from raw_upload
  `, supabaseClient.pushEmployeeMapping, onStage);
}

export async function ingestSkuMapping(supabaseClient, onStage) {
  return ingestGeneric(`
    select "Client" as client, "Product SKU" as sku, "Product Name" as product_name
    from raw_upload
  `, supabaseClient.pushSkuMapping, onStage);
}

// Helper: load a table, or create an empty-but-correctly-shaped one if the
// pull came back with nothing (a brand new project, or a date range with no
// version assignment yet) -- degrades gracefully rather than erroring,
// same principle the old benchmark-table loader used.
async function loadOrEmpty(rows, tableName, emptyDDL) {
  if (rows && rows.length) {
    await loadRowsAsTable(rows, tableName);
  } else {
    await conn.query(`create or replace table ${tableName} (${emptyDDL})`);
  }
}

// FLOW B: runs every time the app loads data (initial open, a filter
// change that needs a wider pull, or after a permit/exception edit) --
// NOT just after a new upload.
export async function loadAndClassify(supabaseClient, filters = {}) {
  const curatedRows = await supabaseClient.pullCuratedPacking(filters);
  await loadRowsAsTable(curatedRows, 'curated_packing');

  const permits = await supabaseClient.pullBreakPermits();
  await loadRowsAsTable(permits, 'break_permits');

  // NEW (migration 001): pull version_assignments + both benchmark tables
  // fresh on every load, same reasoning as the old ensureLocalBenchmarkTables
  // had -- these change rarely but must always be current, and an admin
  // reassigning a date range should be reflected the next time anyone loads
  // data, with no separate "reclassify" step.
  const assignments = await supabaseClient.pullVersionAssignments();
  await loadOrEmpty(assignments, 'version_assignments',
    'id bigint, start_date date, end_date date, effective_label text, created_at timestamp');

  const benchRows = await supabaseClient.pullBenchmarkVersions();
  await loadOrEmpty(benchRows, 'benchmark_versions',
    'id bigint, client text, signature text, lines_per_order integer, p25 double, p50 double, p75 double, trimmed double, usable boolean, spread_flag text, effective_label text');

  const fallbackRows = await supabaseClient.pullBrandFallbackBenchmark();
  await loadOrEmpty(fallbackRows, 'brand_fallback_benchmark',
    'id bigint, client text, p25 double, p50 double, p75 double, trimmed double, effective_label text');

  await resolveBenchmarks();
  await conn.query(`create or replace table classification_result as ${classificationQueryText()}`);
  await buildNetSvaView(filters.statKey || 'bench_p50');

  return conn.query(`select * from curated_packing_with_net_sva`);
}
