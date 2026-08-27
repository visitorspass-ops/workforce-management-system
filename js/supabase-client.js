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
============================================================================ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let supabase = null;

// initSupabase() returns a WRAPPER object bundling every function below as
// a method, NOT the raw Supabase client from createClient(). Every
// duckdb-engine.js call site uses supabaseClient.pushX()/.pullX() as if
// these were methods on the client -- they weren't, until this wrapper.
// (Caught for real only once both files were wired together and actually
// run: pushBenchmarkVersion errored first here, but every push/pull call
// throughout duckdb-engine.js had the identical mismatch.)
export function initSupabase(projectUrl, anonKey) {
  supabase = createClient(projectUrl, anonKey);
  return {
    pushCuratedRows, pushWmsPresence, pullCuratedPacking,
    pullLatestBenchmark, pushBenchmarkVersion,
    pullLatestBrandFallback, pushBrandFallback,
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
   COMPUTED DATA — one-directional push after DuckDB curates+classifies,
   pull on every return visit. Matches the append-only design in
   schema.sql (curated_packing and benchmark_versions are insert-only).
   ---------------------------------------------------------------------- */

export async function pushCuratedRows(rows) {
  // Batches of 500 -- Supabase's REST insert endpoint has practical payload
  // limits; batching also keeps a single failure from losing an entire
  // day's upload (each batch either fully succeeds or fully fails).
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('curated_packing').insert(batch);
    if (error) throw new Error(`Curated row push failed at batch ${i / BATCH_SIZE}: ${error.message}`);
  }
}

export async function pushWmsPresence(rows) {
  // Deduped upsert on (transaction_user_login, activity_date) -- re-running
  // an upload for the same date range shouldn't create duplicate presence rows.
  const { error } = await supabase.from('wms_presence')
    .upsert(rows, { onConflict: 'transaction_user_login,activity_date' });
  if (error) throw new Error(`WMS presence push failed: ${error.message}`);
}

export async function pullCuratedPacking(filters = {}) {
  let q = supabase.from('curated_packing').select('*');
  if (filters.orderType) q = q.eq('order_type', filters.orderType);
  if (filters.client) q = q.eq('client', filters.client);
  if (filters.dateStart) q = q.gte('ts', filters.dateStart);
  if (filters.dateEnd) q = q.lte('ts', filters.dateEnd);
  const { data, error } = await q;
  if (error) throw new Error(`Pulling curated_packing failed: ${error.message}`);
  return data;
}

export async function pullLatestBenchmark() {
  const { data, error } = await supabase.from('benchmark_latest').select('*');
  if (error) throw new Error(`Pulling benchmark_latest failed: ${error.message}`);
  return data;
}

export async function pushBenchmarkVersion(rows) {
  const { error } = await supabase.from('benchmark_versions').insert(rows);
  if (error) throw new Error(`Benchmark push failed: ${error.message}`);
}

export async function pullLatestBrandFallback() {
  const { data, error } = await supabase.from('brand_fallback_latest').select('*');
  if (error) throw new Error(`Pulling brand_fallback_latest failed: ${error.message}`);
  return data;
}

export async function pushBrandFallback(rows) {
  const { error } = await supabase.from('brand_fallback_benchmark').insert(rows);
  if (error) throw new Error(`Brand fallback push failed: ${error.message}`);
}

/* ----------------------------------------------------------------------
   REFERENCE / MAPPING DATA — replaced wholesale on each new upload
   ---------------------------------------------------------------------- */

export async function pushSkuMapping(rows) {
  // Last-write-wins on (client, sku), per the confirmed policy -- no
  // conflict UI, whichever row lands wins.
  const { error } = await supabase.from('sku_mapping').upsert(rows, { onConflict: 'client,sku' });
  if (error) throw new Error(`SKU mapping push failed: ${error.message}`);
}

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

export async function pushAttendance(rows) {
  const { error } = await supabase.from('attendance_daily')
    .upsert(rows, { onConflict: 'employee_id,shift_date' });
  if (error) throw new Error(`Attendance push failed: ${error.message}`);
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
