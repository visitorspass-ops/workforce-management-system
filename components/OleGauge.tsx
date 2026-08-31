import { oleColor } from "@/lib/metrics";

const RADIUS = 60;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ~377, matches the original hand-picked constant

const STROKE_HEX: Record<"go" | "amber" | "red", string> = {
  go: "#00ff66",
  amber: "#e5a938",
  red: "#e54d4d",
};

/**
 * Circular OLE meter. Color now varies with score (fix for the earlier bug
 * where the ring was hardcoded green regardless of value) — same threshold
 * scale as the per-worker OLE badge in View 2, see lib/metrics.ts oleColor().
 */
export function OleGauge({ scorePct, availabilityPct, performancePct }: { scorePct: number; availabilityPct: number; performancePct: number }) {
  const color = oleColor(scorePct);
  const offset = CIRCUMFERENCE - CIRCUMFERENCE * (Math.min(100, Math.max(0, scorePct)) / 100);

  return (
    <div className="bg-panel border border-border rounded-xl p-5 flex flex-col items-center text-center row-span-2">
      <div className="w-full text-left font-mono text-[11px] uppercase tracking-wide text-muted">OLE Efficiency Rating</div>
      <div className="relative w-[140px] h-[140px] my-4">
        <svg viewBox="0 0 140 140" className="w-full h-full -rotate-90">
          <circle cx="70" cy="70" r={RADIUS} fill="none" stroke="#111812" strokeWidth="12" />
          <circle
            cx="70"
            cy="70"
            r={RADIUS}
            fill="none"
            stroke={STROKE_HEX[color]}
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.3s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="font-display text-3xl font-bold" style={{ color: STROKE_HEX[color] }}>
            {scorePct.toFixed(1)}%
          </div>
          <div className="font-mono text-[10px] text-muted mt-0.5">OLE SCORE</div>
        </div>
      </div>
      <div className="w-full font-mono text-[11px] text-muted border-t border-border pt-2.5">
        Avail: <b className="text-text">{availabilityPct.toFixed(0)}%</b> | Perf: <b className="text-text">{performancePct.toFixed(0)}%</b>
      </div>
    </div>
  );
}
