import { getPackerDailyRange, getPackerHourlyRange, getPackerDirectory, getStationBadgesByPacker } from "@/lib/queries";
import { computeOle, oleColor, netSvaBalanceHours, netSvaPerformancePerOrder, confidenceTier } from "@/lib/metrics";
import { Badge, DeltaBadge } from "@/components/Badge";
import type { PackerDailyAgg, PackerHourlyAgg } from "@/lib/types";

export const dynamic = "force-dynamic";

const HOURS = Array.from({ length: 24 }, (_, i) => i); // full 24h — the 6am-10pm
// cutoff was dropping real night-shift hours (April.csv has a 7PM-7AM shift
// line); this scrolls horizontally inside the existing .tablewrap pattern
// instead of hardcoding a clock window.

function defaultWeek(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

type PackerAgg = {
  packerLogin: string;
  displayName: string;
  agency: string | null;
  matchStatus: string | null;
  stations: string[];
  totalOrders: number;
  stdMinutes: number;
  actualMinutes: number;
  unattributedMinutes: number;
  flagged: number;
  hourly: number[]; // 24 buckets
};

export default async function View2Page({
  searchParams,
}: {
  searchParams: { start?: string; end?: string; orderType?: "B2C" | "B2B" };
}) {
  const { start: defStart, end: defEnd } = defaultWeek();
  const startDate = searchParams.start ?? defStart;
  const endDate = searchParams.end ?? defEnd;
  const orderType = searchParams.orderType ?? "B2C";

  let daily: PackerDailyAgg[] = [];
  let hourly: PackerHourlyAgg[] = [];
  let directory: Awaited<ReturnType<typeof getPackerDirectory>> = new Map();
  let stationsByPacker: Map<string, Set<string>> = new Map();
  let fetchError: string | null = null;

  try {
    [daily, hourly, directory, stationsByPacker] = await Promise.all([
      getPackerDailyRange(startDate, endDate, orderType),
      getPackerHourlyRange(startDate, endDate, orderType),
      getPackerDirectory(startDate, endDate),
      getStationBadgesByPacker(startDate, endDate, orderType),
    ]);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Failed to load packer aggregates from Supabase.";
  }

  if (fetchError) {
    return (
      <main className="p-8 font-mono text-sm text-red">
        Could not load View 2 data: {fetchError}
        <div className="text-muted mt-2">
          Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set in the Vercel project, and that{" "}
          <code>scripts/ingest.ts</code> has been run at least once.
        </div>
      </main>
    );
  }

  const byPacker = new Map<string, PackerAgg>();
  for (const row of daily) {
    if (!byPacker.has(row.packer_login)) {
      const info = directory.get(row.packer_login.trim().toLowerCase());
      byPacker.set(row.packer_login, {
        packerLogin: row.packer_login,
        displayName: info?.name ?? row.packer_login,
        agency: info?.agency ?? null,
        matchStatus: info?.matchStatus ?? null,
        stations: Array.from(stationsByPacker.get(row.packer_login) ?? []),
        totalOrders: 0,
        stdMinutes: 0,
        actualMinutes: 0,
        unattributedMinutes: 0,
        flagged: 0,
        hourly: new Array(24).fill(0),
      });
    }
    const acc = byPacker.get(row.packer_login)!;
    acc.totalOrders += row.total_orders;
    acc.stdMinutes += row.std_minutes_p50 ?? 0;
    acc.actualMinutes += row.actual_minutes ?? 0;
    acc.unattributedMinutes += row.unattributed_min ?? 0;
    acc.flagged += row.flagged_slow_orders;
  }
  for (const row of hourly) {
    const acc = byPacker.get(row.packer_login);
    if (acc) acc.hourly[row.hour_of_day] += row.orders_packed;
  }

  const packers = Array.from(byPacker.values());
  const ranked = packers
    .map((p) => {
      const tier = confidenceTier(p.totalOrders);
      const ole = computeOle({ stdMinutes: p.stdMinutes, actualMinutes: p.actualMinutes, unattributedMinutes: p.unattributedMinutes });
      const balance = netSvaBalanceHours(p.stdMinutes, p.actualMinutes);
      const perOrder = netSvaPerformancePerOrder(p.stdMinutes, p.actualMinutes, p.totalOrders);
      return { ...p, tier, ole, balance, perOrder };
    })
    .filter((p) => p.tier !== "excluded")
    .sort((a, b) => b.balance - a.balance);

  const excludedCount = packers.length - ranked.length;
  const totalSurplus = ranked.reduce((acc, p) => acc + p.balance, 0);

  return (
    <main className="min-h-screen p-7">
      <div className="mb-5">
        <h1 className="font-display text-2xl font-bold">Packer Overview &amp; Shift Logs</h1>
        <div className="font-mono text-xs text-muted mt-1">
          {startDate} → {endDate} · {orderType}
        </div>
      </div>

      <div className="bg-panel border border-border rounded-lg p-4 mb-5">
        <div className="font-mono text-[11px] uppercase tracking-wide text-muted mb-3">
          Worker Divergence Leaderboard — Net SvA Balance
        </div>
        <div className="flex flex-col gap-2">
          {ranked.map((p, i) => {
            const olePct = p.ole ? p.ole.score * 100 : 0;
            return (
              <div key={p.packerLogin} className="flex items-center gap-3 font-mono text-[12.5px]">
                <span className="text-muted w-6 text-right">{i + 1}.</span>
                <span className="text-text font-medium flex-1 truncate">{p.displayName}</span>
                {p.matchStatus === "UNMATCHED" && <Badge tone="amber">unmatched login</Badge>}
                {p.stations.map((s) => (
                  <Badge key={s} tone="blue">
                    {s}
                  </Badge>
                ))}
                <span className="text-muted w-20 text-right">{p.totalOrders} ord</span>
                {p.ole ? (
                  <Badge tone={oleColor(olePct)}>{olePct.toFixed(1)}% OLE</Badge>
                ) : (
                  <Badge tone="muted">— OLE</Badge>
                )}
                {p.tier === "low" && <Badge tone="amber">low confidence (&lt;25 ord)</Badge>}
                <span className={p.balance >= 0 ? "text-go" : "text-red"}>
                  {p.balance >= 0 ? "+" : ""}
                  {p.balance.toFixed(2)}h
                </span>
              </div>
            );
          })}
          {excludedCount > 0 && (
            <div className="font-mono text-[11px] text-muted pt-2 border-t border-border">
              {excludedCount} packer(s) below the {10}-order floor for this window — excluded from ranking, not shown.
            </div>
          )}
        </div>
        <div className="font-mono text-[11px] text-muted mt-3 pt-3 border-t border-border">
          Total: {totalSurplus >= 0 ? "+" : ""}
          {totalSurplus.toFixed(1)}h {totalSurplus >= 0 ? "Surplus" : "Deficit"}
        </div>
      </div>

      <div className="flex items-center justify-between mb-2.5">
        <div className="font-display text-base font-semibold">Hourly Packing Throughput (24h, scrolls →)</div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="text-[12px] bg-panel" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr className="font-mono text-[10px] uppercase text-muted border-t-2 border-t-go border-b border-border">
              <th className="text-left p-2 sticky left-0 bg-panel2" style={{ minWidth: 180 }}>
                Packer &amp; Agency
              </th>
              <th className="p-2" style={{ minWidth: 70 }}>
                OLE
              </th>
              <th className="p-2" style={{ minWidth: 120 }}>
                Net SvA Performance
              </th>
              {HOURS.map((h) => (
                <th key={h} className="p-2 font-normal" style={{ minWidth: 34 }}>
                  {h}-{h + 1}
                </th>
              ))}
              <th className="p-2" style={{ minWidth: 50 }}>
                Flags
              </th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((p) => {
              const olePct = p.ole ? p.ole.score * 100 : 0;
              return (
                <tr key={p.packerLogin} className="border-b border-border last:border-0">
                  <td className="text-left p-2 sticky left-0 bg-panel font-medium">
                    {p.displayName}
                    <div className="text-muted text-[10.5px] font-normal">{p.agency ?? "—"}</div>
                  </td>
                  <td className="p-2 text-center">
                    {p.ole ? <Badge tone={oleColor(olePct)}>{olePct.toFixed(1)}%</Badge> : <Badge tone="muted">—</Badge>}
                  </td>
                  <td className="p-2 text-center">
                    {p.perOrder === null ? (
                      "—"
                    ) : (
                      <span className={p.perOrder >= 0 ? "text-go" : "text-red"}>
                        {p.perOrder >= 0 ? "+" : ""}
                        {p.perOrder.toFixed(2)}m
                      </span>
                    )}
                  </td>
                  {HOURS.map((h) => {
                    const n = p.hourly[h];
                    return (
                      <td key={h} className="p-2 text-center text-muted">
                        {n > 0 ? n : "·"}
                      </td>
                    );
                  })}
                  <td className="p-2 text-center">{p.flagged > 0 ? <Badge tone="red">{p.flagged}</Badge> : <Badge tone="go">0</Badge>}</td>
                </tr>
              );
            })}
            {ranked.length === 0 && (
              <tr>
                <td colSpan={HOURS.length + 4} className="p-6 text-center text-muted font-mono text-xs">
                  No packer activity for this window. Run scripts/ingest.ts first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
