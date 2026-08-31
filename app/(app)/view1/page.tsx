import { getBrandDaily } from "@/lib/queries";
import { computeOle, netSvaBalanceHours, ophColor } from "@/lib/metrics";
import { OleGauge } from "@/components/OleGauge";
import { Badge, DeltaBadge } from "@/components/Badge";
import type { BrandDailyAgg } from "@/lib/types";

export const dynamic = "force-dynamic"; // always read live Supabase data, never a stale build

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sumField(rows: BrandDailyAgg[], field: keyof BrandDailyAgg): number {
  return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
}

export default async function View1Page({
  searchParams,
}: {
  searchParams: { date?: string; orderType?: "B2C" | "B2B" };
}) {
  const date = searchParams.date ?? new Date().toISOString().slice(0, 10);
  const orderType = searchParams.orderType ?? "B2C";
  const priorDate = addDays(date, -1);

  let rows: BrandDailyAgg[] = [];
  let priorRows: BrandDailyAgg[] = [];
  let fetchError: string | null = null;
  try {
    [rows, priorRows] = await Promise.all([getBrandDaily(date, orderType), getBrandDaily(priorDate, orderType)]);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Failed to load brand_daily_agg from Supabase.";
  }

  if (fetchError) {
    return (
      <main className="p-8 font-mono text-sm text-red">
        Could not load View 1 data: {fetchError}
        <div className="text-muted mt-2">
          Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set in the Vercel project, and that{" "}
          <code>scripts/ingest.ts</code> has been run at least once.
        </div>
      </main>
    );
  }

  const totalStd = sumField(rows, "std_minutes_p50");
  const totalActual = sumField(rows, "actual_minutes");
  const totalUnattributed = sumField(rows, "unattributed_min");
  const totalOrders = sumField(rows, "total_orders");
  const totalFlagged = sumField(rows, "flagged_slow_orders");

  const ole = computeOle({ stdMinutes: totalStd, actualMinutes: totalActual, unattributedMinutes: totalUnattributed });
  const olePct = ole ? ole.score * 100 : 0;
  const availPct = ole ? ole.availability * 100 : 0;
  const perfPct = ole ? ole.performance * 100 : 0;

  const priorStd = sumField(priorRows, "std_minutes_p50");
  const priorActual = sumField(priorRows, "actual_minutes");
  const priorUnattributed = sumField(priorRows, "unattributed_min");
  const priorOle = computeOle({ stdMinutes: priorStd, actualMinutes: priorActual, unattributedMinutes: priorUnattributed });
  const priorOlePct = priorOle ? priorOle.score * 100 : null;

  const netSvaBalance = netSvaBalanceHours(totalStd, totalActual);
  const priorNetSvaBalance = priorRows.length ? netSvaBalanceHours(priorStd, priorActual) : null;

  const brandRows = [...rows].sort((a, b) => (b.std_minutes_p50 ?? 0) - (a.std_minutes_p50 ?? 0));

  return (
    <main className="min-h-screen p-7">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Per Brand Execution</h1>
          <div className="font-mono text-xs text-muted mt-1">
            {date} · {orderType}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[300px_repeat(3,1fr)] gap-4 mb-5 items-stretch">
        <OleGauge scorePct={olePct} availabilityPct={availPct} performancePct={perfPct} />

        <div className="bg-panel border border-border rounded-lg p-4">
          <div className="font-mono text-[10px] uppercase tracking-wide text-muted mb-1.5">Active Brands</div>
          <div className="font-mono text-xl font-semibold text-blue">{rows.length} Brands</div>
          <DeltaBadge current={rows.length} prior={priorRows.length || null} />
        </div>

        <div className="bg-panel border border-border rounded-lg p-4 col-span-2 grid grid-cols-2 gap-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted mb-1.5">Allocated Std Hours</div>
            <div className="font-mono text-xl font-semibold text-blue">{(totalStd / 60).toFixed(1)}h</div>
            <DeltaBadge current={totalStd / 60} prior={priorRows.length ? priorStd / 60 : null} unit="h" />
          </div>
          <div className="border-l border-border pl-4">
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted mb-1.5">Packing Time Used</div>
            <div className="font-mono text-xl font-semibold text-blue">{(totalActual / 60).toFixed(1)}h</div>
            <DeltaBadge current={totalActual / 60} prior={priorRows.length ? priorActual / 60 : null} unit="h" />
          </div>
        </div>

        <div className="bg-panel border border-border rounded-lg p-4 col-span-2 grid grid-cols-2 gap-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted mb-1.5">Net SvA Balance</div>
            <div className={`font-mono text-xl font-semibold ${netSvaBalance >= 0 ? "text-go" : "text-red"}`}>
              {netSvaBalance >= 0 ? "+" : ""}
              {netSvaBalance.toFixed(1)}h Surplus
            </div>
            <DeltaBadge current={netSvaBalance} prior={priorNetSvaBalance} unit="h" />
          </div>
          <div className="border-l border-border pl-4">
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted mb-1.5">Unattributed Idle Time</div>
            <div className="font-mono text-xl font-semibold text-red">{(totalUnattributed / 60).toFixed(1)}h</div>
            <DeltaBadge current={totalUnattributed / 60} prior={priorRows.length ? priorUnattributed / 60 : null} inverse unit="h" />
          </div>
        </div>

        <div className="bg-panel border border-border rounded-lg p-4">
          <div className="font-mono text-[10px] uppercase tracking-wide text-muted mb-1.5">Flag Rate</div>
          <div className="font-mono text-xl font-semibold text-red">{totalOrders ? ((totalFlagged / totalOrders) * 100).toFixed(1) : "0.0"}%</div>
          <div className="font-mono text-[9.5px] text-muted mt-1">Actual &gt; p50 standard</div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-2.5">
        <div className="font-display text-base font-semibold">Brand Allocated Standard Hours</div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-[12.5px] bg-panel">
          <thead>
            <tr className="font-mono text-[10px] uppercase text-muted border-t-2 border-t-go border-b border-border">
              <th className="text-left p-2.5">Brand Client</th>
              <th className="p-2.5">Orders</th>
              <th className="p-2.5">Std Hrs</th>
              <th className="p-2.5">Act Hrs</th>
              <th className="p-2.5">OPH</th>
              <th className="p-2.5">Flag %</th>
              <th className="p-2.5">Bench Tier</th>
            </tr>
          </thead>
          <tbody>
            {brandRows.map((b) => {
              const stdHrs = (b.std_minutes_p50 ?? 0) / 60;
              const actHrs = (b.actual_minutes ?? 0) / 60;
              const oph = actHrs > 0 ? b.total_orders / actHrs : 0;
              // Target OPH from p50 (minutes/order) — fallback-tier orders
              // already carry the brand fallback duration into std_minutes_p50,
              // so this stays correct even on fully-fallback brands.
              const targetOph = b.total_orders > 0 && b.std_minutes_p50 ? 60 / (b.std_minutes_p50 / b.total_orders) : 0;
              const flagPct = b.total_orders ? (b.flagged_slow_orders / b.total_orders) * 100 : 0;
              const sigPct = b.total_orders ? (b.orders_on_signature_tier / b.total_orders) * 100 : 0;
              const fbkPct = 100 - sigPct;
              return (
                <tr key={b.client} className="border-b border-border last:border-0">
                  <td className="text-left p-2.5 font-semibold">{b.client}</td>
                  <td className="p-2.5 text-center font-mono">{b.total_orders.toLocaleString()}</td>
                  <td className="p-2.5 text-center font-mono text-go">{stdHrs.toFixed(1)}h</td>
                  <td className="p-2.5 text-center font-mono text-go">{actHrs.toFixed(1)}h</td>
                  <td className="p-2.5 text-center">
                    <Badge tone={ophColor(oph, targetOph)}>{oph.toFixed(1)} OPH</Badge>
                  </td>
                  <td className="p-2.5 text-center font-mono">{flagPct.toFixed(1)}%</td>
                  <td className="p-2.5 text-center font-mono text-[11px]">
                    {sigPct.toFixed(0)}% sig
                    <br />
                    <span className={fbkPct > 50 ? "text-amber" : "text-muted"}>{fbkPct.toFixed(0)}% fbk</span>
                  </td>
                </tr>
              );
            })}
            {brandRows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted font-mono text-xs">
                  No orders for {date} ({orderType}). Run scripts/ingest.ts against this date range first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
