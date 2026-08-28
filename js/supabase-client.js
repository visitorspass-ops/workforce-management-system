/* ============================================================================
   supabase-client.js — Supabase wrapper for Shift Manifest WFM
   ============================================================================
   IMPORTANT LIMITATION, stated plainly: this file was written against the
   real supabase-js v2 API surface, but *.supabase.co is not reachable from
   the sandbox this project was built in, so none of these calls have been
   executed against your actual project. This is fundamentally different
   from every SQL query in duckdb-engine.js, which WAS run and verified
   against real DuckDB. Treat this file as carefully-constructed but
   NOT verified-by-execution until it's tested against your live project.

   CHANGED (migration 001): the push functions below no longer do REST
   insert/upsert loops at all. Each one now calls a bulk_insert_* Postgres
   function via .rpc() -- one network round-trip per chunk, with the whole
   chunk inserted server-side in a single set-based INSERT. This replaces
   the earlier "batch at 500 rows" fix, which only reduced payload size per
   call; at 80-90k rows/day, a REST insert LOOP (batched or not) is still
   tens to hundreds of sequential round-trips. RPC chunks run in bounded
   parallel batches instead of one-at-a-time, since these rows have no
   ordering dependency on each other (curated_packing is append-only).
============================================================================ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let supabase = null;

export function initSupabase(projectUrl, anonKey) {
  supabase = createClient(projectUrl, anonKey);
  return {
    pushCuratedRows, pushWmsPresence, pullCuratedPacking,
    pullBenchmarkVersions, pushBenchmarkVersion,
    pullBrandFallbackBenchmark, pushBrandFallback,
    pullVersionAssignments, addVersionAssignment,
    pushSkuMapping, pullSkuMapping,
    pushEmployeeMapping, pullEmployeeMapping,
    pushAttendance, pullAttendance,
    pullBreakPermits, addBreakPermit, removeBreakPermit,
    upsertExceptionMeta, pullExceptionMeta,
    subscribeToLiveChanges,
    raw: supabase, // escape hatch for direct client access if ever needed
  };
}

/* ----------------------------------------------------------------------
   BULK RPC PUSH — shared helper for every high-volume table. Chunks the
   row array, fires CONCURRENCY chunks at a time via Promise.all, calls
   the matching bulk_insert_* function (see migration_001.sql) per chunk.

   CHUNK_SIZE=5000, not 500: each RPC call does one INSERT ... SELECT FROM
   jsonb_to_recordset(...) server-side, so the per-call cost is dominated
   by JSON payload size, not row count in the old REST-insert sense. 5,000
   rows keeps a single call comfortably under typical payload limits even
   for wide rows (benchmark's long signature strings) -- tune down if you
   see request-size errors in practice, tune up if it's comfortably fast.

   CONCURRENCY=4: bounded, not unlimited -- avoids hammering the DB with
   every chunk at once on a very large upload, while still being far
   faster than one-at-a-time.
   ---------------------------------------------------------------------- */
const CHUNK_SIZE = 5000;
const CONCURRENCY = 4;

async function pushViaBulkRpc(fnName, rows, onProgress) {
  if (!rows || !rows.length) return 0;
  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) chunks.push(rows.slice(i, i + CHUNK_SIZE));
  const totalChunks = chunks.length;

  let totalInserted = 0;
  let chunksDone = 0;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(chunk => supabase.rpc(fnName, { payload: chunk })));
    results.forEach((r, idx) => {
      if (r.error) throw new Error(`${fnName} failed at chunk ${i + idx}: ${r.error.message}`);
      totalInserted += (r.data ?? 0);
    });
    chunksDone += batch.length;
    if (onProgress) onProgress({ chunksDone, totalChunks, rowsDone: Math.min(chunksDone * CHUNK_SIZE, rows.length), totalRows: rows.length });
  }
  return totalInserted;
}

export async function pushCuratedRows(rows, onProgress) {
  return pushViaBulkRpc('bulk_insert_curated_packing', rows, onProgress);
}

export async function pushWmsPresence(rows, onProgress) {
  return pushViaBulkRpc('bulk_insert_wms_presence', rows, onProgress);
}

export async function pushBenchmarkVersion(rows, onProgress) {
  return pushViaBulkRpc('bulk_insert_benchmark_versions', rows, onProgress);
}

export async function pushBrandFallback(rows, onProgress) {
  return pushViaBulkRpc('bulk_insert_brand_fallback', rows, onProgress);
}

export async function pushSkuMapping(rows, onProgress) {
  return pushViaBulkRpc('bulk_insert_sku_mapping', rows, onProgress);
}

export async function pushAttendance(rows, onProgress) {
  return pushViaBulkRpc('bulk_insert_attendance', rows, onProgress);
}

/* ----------------------------------------------------------------------
   READ PATH — pullCuratedPacking now paginates for real.

   Per your call: pull EXACTLY the range requested, no snapping to
   calendar-month boundaries. A request spanning March 29-April 3 pulls
   exactly that window, nothing wider. Pagination is an inner loop within
   that exact range -- it exists purely so a single request never silently
   truncates at Supabase's row cap (default 1,000; raise "Max Rows" in
   Project Settings > API, but this loop doesn't depend on that setting
   being changed -- it keeps requesting until a page comes back short).
   ---------------------------------------------------------------------- */
const PAGE_SIZE = 1000; // matches the Supabase default; safe even if you haven't raised Max Rows yet

export async function pullCuratedPacking(filters = {}) {
  const all = [];
  let from = 0;
  while (true) {
    let q = supabase.from('curated_packing').select('*').range(from, from + PAGE_SIZE - 1);
    if (filters.orderType) q = q.eq('order_type', filters.orderType);
    if (filters.client) q = q.eq('client', filters.client);
    if (filters.dateStart) q = q.gte('ts', filters.dateStart);
    if (filters.dateEnd) q = q.lte('ts', filters.dateEnd);
    const { data, error } = await q;
    if (error) throw new Error(`Pulling curated_packing failed at offset ${from}: ${error.message}`);
    all.push(...data);
    if (data.length < PAGE_SIZE) break; // short page = done, whether or not it crossed a month boundary
    from += PAGE_SIZE;
  }
  return all;
}

export async function pullBenchmarkVersions() {
  // Full pull of benchmark_versions -- no "latest" filtering here anymore
  // (that view is dropped). Query-time resolution in duckdb-engine.js joins
  // this against version_assignments to pick the right rows per date.
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from('benchmark_versions').select('*').range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Pulling benchmark_versions failed at offset ${from}: ${error.message}`);
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

export async function pullBrandFallbackBenchmark() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from('brand_fallback_benchmark').select('*').range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Pulling brand_fallback_benchmark failed at offset ${from}: ${error.message}`);
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/* ----------------------------------------------------------------------
   VERSION ASSIGNMENTS — admin-maintained date-range -> label mapping.
   Small table (a handful of rows, ever), no pagination needed. This is
   the write path the admin UI (not yet built) will call.
   ---------------------------------------------------------------------- */
export async function pullVersionAssignments() {
  const { data, error } = await supabase.from('version_assignments').select('*');
  if (error) throw new Error(`Pulling version_assignments failed: ${error.message}`);
  return data;
}

export async function addVersionAssignment({ startDate, endDate, effectiveLabel, createdBy }) {
  const { data, error } = await supabase.from('version_assignments')
    .insert({ start_date: startDate, end_date: endDate, effective_label: effectiveLabel, created_by: createdBy || null })
    .select();
  if (error) throw new Error(`Adding version assignment failed: ${error.message}`);
  return data[0];
}

/* ----------------------------------------------------------------------
   REFERENCE / MAPPING DATA — replaced wholesale on each new upload
   ---------------------------------------------------------------------- */

export async function pullSkuMapping() {
  const { data, error } = await supabase.from('sku_mapping').select('*');
  if (error) throw new Error(`Pulling sku_mapping failed: ${error.message}`);
  return data;
}

export async function pushEmployeeMapping(rows) {
  const { error } = await supabase.from('employee_mapping').upsert(rows, { onConflict: 'employee_id' });
  if (error) throw new Error(`Employee mapping push failed: ${error.message}`);
}

export async function pullEmployeeMapping() {
  const { data, error } = await supabase.from('employee_mapping').select('*');
  if (error) throw new Error(`Pulling employee_mapping failed: ${error.message}`);
  return data;
}

export async function pullAttendance(dateStart, dateEnd) {
  let q = supabase.from('attendance_daily').select('*');
  if (dateStart) q = q.gte('shift_date', dateStart);
  if (dateEnd) q = q.lte('shift_date', dateEnd);
  const { data, error } = await q;
  if (error) throw new Error(`Pulling attendance_daily failed: ${error.message}`);
  return data;
}

/* ----------------------------------------------------------------------
   OPERATOR JUDGMENT — live reads/writes, made directly by a person in
   the app. This is what makes break permits and exception edits actually
   shared across devices in real time, unlike the old localStorage version.
   ---------------------------------------------------------------------- */

export async function pullBreakPermits(permitDate = null) {
  let q = supabase.from('break_permits').select('*');
  if (permitDate) q = q.eq('permit_date', permitDate);
  const { data, error } = await q;
  if (error) throw new Error(`Pulling break_permits failed: ${error.message}`);
  return data;
}

export async function addBreakPermit(permit) {
  const { data, error } = await supabase.from('break_permits').insert(permit).select();
  if (error) throw new Error(`Adding break permit failed: ${error.message}`);
  return data[0];
}

export async function removeBreakPermit(id) {
  const { error } = await supabase.from('break_permits').delete().eq('id', id);
  if (error) throw new Error(`Removing break permit failed: ${error.message}`);
}

export async function upsertExceptionMeta(rowKey, patch) {
  const { error } = await supabase.from('exception_meta')
    .upsert({ row_key: rowKey, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'row_key' });
  if (error) throw new Error(`Exception meta write failed for ${rowKey}: ${error.message}`);
}

export async function pullExceptionMeta() {
  const { data, error } = await supabase.from('exception_meta').select('*');
  if (error) throw new Error(`Pulling exception_meta failed: ${error.message}`);
  return data;
}

/* ----------------------------------------------------------------------
   LIVE SYNC — optional: subscribe to break_permits/exception_meta changes
   so a permit logged on one device appears on another without a manual
   refresh. Supabase Realtime, built on the same tables above -- no schema
   change needed, just a subscription.
   ---------------------------------------------------------------------- */
export function subscribeToLiveChanges(onBreakPermitChange, onExceptionMetaChange) {
  const channel = supabase.channel('wfm-live-writes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'break_permits' },
        payload => onBreakPermitChange(payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'exception_meta' },
        payload => onExceptionMetaChange(payload))
    .subscribe();
  return () => supabase.removeChannel(channel); // returns an unsubscribe function
}
