const TONE_CLASSES: Record<"go" | "amber" | "red" | "blue" | "purple" | "muted", string> = {
  go: "bg-goDim text-go",
  amber: "bg-amberDim text-amber",
  red: "bg-redDim text-[#ffb3b6]",
  // Station tag: settled decision — reuse --go, rendered as a pill so it
  // reads as an identity tag, never as a "good status" claim. No new hue.
  blue: "bg-goDim text-go",
  purple: "bg-purpleDim text-purple",
  muted: "bg-panel2 text-muted border border-border",
};

export function Badge({
  tone,
  children,
}: {
  tone: "go" | "amber" | "red" | "blue" | "purple" | "muted";
  children: React.ReactNode;
}) {
  return <span className={`badge-pill ${TONE_CLASSES[tone]}`}>{children}</span>;
}

export function DeltaBadge({ current, prior, inverse = false, unit = "" }: { current: number; prior: number | null; inverse?: boolean; unit?: string }) {
  if (prior === null || prior === undefined || Number.isNaN(prior) || prior === 0) {
    return <Badge tone="muted">—</Badge>;
  }
  const diff = current - prior;
  const pct = (diff / prior) * 100;
  const isPositive = inverse ? diff < 0 : diff > 0;
  const arrow = diff >= 0 ? "▲" : "▼";
  const formatted = `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}${unit}`;
  return (
    <Badge tone={isPositive ? "go" : "red"}>
      {arrow} {formatted} ({pct >= 0 ? "+" : ""}
      {pct.toFixed(1)}%)
    </Badge>
  );
}
