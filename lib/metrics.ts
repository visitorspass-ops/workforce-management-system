/**
 * Shared metric math for View 1 and View 2. One implementation, both views —
 * this is the "one consistent policy instead of a new number per feature"
 * rule the project holds itself to elsewhere (min-orders floor, etc.),
 * applied to OLE too.
 */

export type OleInputs = {
  stdMinutes: number; // earned standard minutes (bench_p50 sum, duration_flag = 'ok')
  actualMinutes: number; // measured minutes (order_duration_min sum, duration_flag = 'ok')
  unattributedMinutes: number; // gaps rejected by max_plausible_duration_min
};

export type Ole = {
  performance: number; // std / actual
  availability: number; // actual / (actual + unattributed)
  score: number; // performance * availability
};

/** Performance × Availability, per claude/agreed-operating-process.md Layer 4.
 *  Never recomputed client-side against a filtered subset that changes its
 *  own denominator — this function is the ONLY place OLE gets computed. */
export function computeOle({ stdMinutes, actualMinutes, unattributedMinutes }: OleInputs): Ole | null {
  if (actualMinutes <= 0) return null;
  const performance = stdMinutes / actualMinutes;
  const totalAttMin = actualMinutes + unattributedMinutes;
  const availability = totalAttMin > 0 ? Math.max(0, Math.min(1, actualMinutes / totalAttMin)) : 1;
  return { performance, availability, score: performance * availability };
}

/** OLE color scale — shared by the View 1 hero gauge and every per-worker
 *  OLE badge in View 2. This is its OWN scale (0-100% of a bounded score),
 *  deliberately NOT the same scale as OPH below (a ratio-to-target that can
 *  exceed 100%) — two different kinds of metric, two threshold sets. */
export function oleColor(scorePct: number): "go" | "amber" | "red" {
  if (scorePct >= 80) return "go";
  if (scorePct >= 70) return "amber";
  return "red";
}

/** OPH (orders per packer-hour) vs. a brand's fallback target — its own
 *  target-ratio scale, not to be confused with oleColor above. */
export function ophColor(actualOph: number, targetOph: number): "go" | "amber" | "red" {
  if (targetOph <= 0) return "go";
  const ratio = actualOph / targetOph;
  if (ratio >= 1) return "go";
  if (ratio >= 0.8) return "amber";
  return "red";
}

/** Net SvA Balance — total hours, earned minus actual. Positive = surplus. */
export function netSvaBalanceHours(stdMinutes: number, actualMinutes: number): number {
  return (stdMinutes - actualMinutes) / 60;
}

/** Net SvA Performance — the per-order RATE, in minutes/order. A distinct
 *  metric from the Balance above (different unit), never the same label. */
export function netSvaPerformancePerOrder(stdMinutes: number, actualMinutes: number, orders: number): number | null {
  if (orders <= 0) return null;
  return (stdMinutes - actualMinutes) / orders;
}

/** Weekly-scoped confidence floor for ranking individuals — reused from
 *  signal1_line_benchmark_packing.py's min_orders (10) and a statistical
 *  default (25), NOT recalibrated against Locad's real variance yet.
 *  Applies to View 2's leaderboard only — View 1 aggregates at brand grain,
 *  which doesn't hit this floor in practice. */
export const CONFIDENCE_FLOOR_EXCLUDE_BELOW = 10;
export const CONFIDENCE_FLOOR_FLAG_BELOW = 25;

export function confidenceTier(ordersInWindow: number): "excluded" | "low" | "normal" {
  if (ordersInWindow < CONFIDENCE_FLOOR_EXCLUDE_BELOW) return "excluded";
  if (ordersInWindow < CONFIDENCE_FLOOR_FLAG_BELOW) return "low";
  return "normal";
}
