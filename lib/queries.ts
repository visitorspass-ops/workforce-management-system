import { supabaseServer } from "@/lib/supabase/server";
import type { BrandDailyAgg, PackerDailyAgg, PackerHourlyAgg } from "@/lib/types";

/** All reads are plain SUMs/COUNTs of numbers already frozen at ingestion —
 *  no median/percentile is ever computed here. That computation happens
 *  once, in scripts/ingest.ts, from the versioned benchmark files. */

export async function getBrandDaily(workDate: string, orderType: "B2C" | "B2B"): Promise<BrandDailyAgg[]> {
  const { data, error } = await supabaseServer()
    .from("brand_daily_agg")
    .select("*")
    .eq("work_date", workDate)
    .eq("order_type", orderType);
  if (error) throw error;
  return (data ?? []) as BrandDailyAgg[];
}

export async function getBrandDailyRange(startDate: string, endDate: string, orderType: "B2C" | "B2B"): Promise<BrandDailyAgg[]> {
  const { data, error } = await supabaseServer()
    .from("brand_daily_agg")
    .select("*")
    .gte("work_date", startDate)
    .lte("work_date", endDate)
    .eq("order_type", orderType);
  if (error) throw error;
  return (data ?? []) as BrandDailyAgg[];
}

export async function getPackerDailyRange(startDate: string, endDate: string, orderType: "B2C" | "B2B"): Promise<PackerDailyAgg[]> {
  const { data, error } = await supabaseServer()
    .from("packer_daily_agg")
    .select("*")
    .gte("work_date", startDate)
    .lte("work_date", endDate)
    .eq("order_type", orderType);
  if (error) throw error;
  return (data ?? []) as PackerDailyAgg[];
}

export async function getPackerHourlyRange(startDate: string, endDate: string, orderType: "B2C" | "B2B"): Promise<PackerHourlyAgg[]> {
  const { data, error } = await supabaseServer()
    .from("packer_hourly_agg")
    .select("*")
    .gte("work_date", startDate)
    .lte("work_date", endDate)
    .eq("order_type", orderType);
  if (error) throw error;
  return (data ?? []) as PackerHourlyAgg[];
}

/** name_wms_mapping + attendance join, scoped to a date range — attendance
 *  is the canonical Employer/Agency source (settled decision), not the
 *  mapping file's own agency column. */
export async function getPackerDirectory(startDate: string, endDate: string) {
  const sb = supabaseServer();
  const [{ data: names, error: e1 }, { data: attendance, error: e2 }] = await Promise.all([
    sb.from("name_wms_mapping").select("employee_id, employee_name, transaction_user_login, match_status"),
    sb.from("attendance").select("employee_id, work_date, employer").gte("work_date", startDate).lte("work_date", endDate),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const employerByEmpId = new Map<string, string>();
  for (const row of attendance ?? []) {
    // Last-seen-in-range wins for "current" employer display; callers that
    // need day-level employer history should query `attendance` directly —
    // this map is for the roster label only.
    if (row.employer) employerByEmpId.set(row.employee_id, row.employer);
  }

  const loginToDisplay = new Map<string, { name: string; agency: string | null; matchStatus: string | null }>();
  for (const row of names ?? []) {
    if (!row.transaction_user_login) continue;
    loginToDisplay.set(row.transaction_user_login.trim().toLowerCase(), {
      name: row.employee_name,
      agency: employerByEmpId.get(row.employee_id) ?? null,
      matchStatus: row.match_status,
    });
  }
  return loginToDisplay;
}

export async function getStationBadgesByPacker(startDate: string, endDate: string, orderType: "B2C" | "B2B") {
  const { data, error } = await supabaseServer()
    .from("curated_packing")
    .select("packer_login, target_location")
    .gte("work_date", startDate)
    .lte("work_date", endDate)
    .eq("order_type", orderType)
    .not("target_location", "is", null);
  if (error) throw error;

  const byPacker = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    if (!row.target_location) continue;
    if (!byPacker.has(row.packer_login)) byPacker.set(row.packer_login, new Set());
    byPacker.get(row.packer_login)!.add(row.target_location);
  }
  return byPacker;
}
