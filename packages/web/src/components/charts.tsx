/*
  Hand-rolled inline SVG charts: no chart library anywhere. Rect-only
  geometry inside stretched viewBoxes stays crisp at any width; anything
  with text uses a fixed aspect. Colors come from the theme tokens.
*/
import type { DistributionSummary } from "../lib/api";
import { fmtInt, fmtPct, fmtValue } from "../lib/format";

const TONES = {
  accent: "var(--accent)",
  green: "var(--green)",
  red: "var(--red)",
  warn: "var(--warn)",
  violet: "var(--accent-2)",
} as const;
export type ChartTone = keyof typeof TONES;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * A proportion bar with its confidence interval: filled bar to the point
 * estimate, a brighter band spanning the 95% CI, and a marker at the
 * estimate. The whole thing spans 0–100%.
 */
export function CiBar({
  estimate,
  ci95,
  tone = "accent",
  height = 14,
}: {
  estimate: number | null;
  ci95: [number, number] | null;
  tone?: ChartTone;
  height?: number;
}) {
  const color = TONES[tone];
  const est = estimate === null ? null : clamp01(estimate) * 100;
  const lo = ci95 === null ? null : clamp01(ci95[0]) * 100;
  const hi = ci95 === null ? null : clamp01(ci95[1]) * 100;
  return (
    <svg
      viewBox="0 0 100 12"
      preserveAspectRatio="none"
      className="block w-full"
      style={{ height }}
      role="img"
      aria-label={
        est === null ? "estimate withheld" : `estimate ${est.toFixed(1)} percent with 95% CI band`
      }
    >
      <rect x="0" y="3" width="100" height="6" rx="1.5" fill="var(--track)" />
      {est !== null ? (
        <rect x="0" y="3" width={est} height="6" rx="1.5" fill={color} opacity="0.45" />
      ) : null}
      {lo !== null && hi !== null ? (
        <rect x={lo} y="4.9" width={Math.max(hi - lo, 0.4)} height="2.2" fill={color} />
      ) : null}
      {est !== null ? (
        <rect x={Math.min(est, 99)} y="1" width="1" height="10" fill="var(--text)" />
      ) : null}
    </svg>
  );
}

/** Per-year estimates as a mini bar chart, with N printed under every year. */
export function YearBars({
  perYear,
}: {
  perYear: { year: number; n: number; successes: number; estimate: number | null }[];
}) {
  const barW = 26;
  const gap = 12;
  const chartH = 56;
  const width = perYear.length * (barW + gap) + gap;
  const height = chartH + 24;
  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="block"
        role="img"
        aria-label="per-year estimates"
      >
        <rect x="0" y={chartH} width={width} height="1" fill="var(--border)" />
        {perYear.map((y, i) => {
          const x = gap + i * (barW + gap);
          const h = y.estimate === null ? 0 : Math.max(clamp01(y.estimate) * chartH, 1.5);
          return (
            <g key={y.year}>
              <title>
                {y.estimate === null
                  ? `${y.year}: no estimate (n ${fmtInt(y.n)})`
                  : `${y.year}: ${fmtPct(y.estimate)} (${fmtInt(y.successes)}/${fmtInt(y.n)})`}
              </title>
              <rect
                x={x}
                y={0}
                width={barW}
                height={chartH}
                fill="var(--track)"
                opacity="0.55"
                rx="2"
              />
              <rect x={x} y={chartH - h} width={barW} height={h} fill="var(--accent)" rx="2" />
              <text
                x={x + barW / 2}
                y={chartH + 10}
                textAnchor="middle"
                fontSize="7.5"
                fill="var(--text-dim)"
              >
                {y.year}
              </text>
              <text
                x={x + barW / 2}
                y={chartH + 19}
                textAnchor="middle"
                fontSize="6.5"
                fill="var(--text-dim)"
                opacity="0.8"
              >
                n {fmtInt(y.n)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Distribution strip for a continuous outcome value: min→max track, a box
 * from p25 to p75, a strong median tick and a p90 tick — each labeled in
 * the legend underneath with its value (labels never collide, whatever the
 * skew of the data).
 */
export function PercentileStrip({ dist }: { dist: DistributionSummary }) {
  const span = dist.max - dist.min;
  const x = (v: number) => (span <= 0 ? 50 : ((v - dist.min) / span) * 100);
  const boxLo = x(dist.p25);
  const boxHi = x(dist.p75);
  const marks: { key: string; label: string; value: number; color: string; w: number }[] = [
    { key: "p25", label: "p25", value: dist.p25, color: "var(--accent)", w: 0.7 },
    { key: "median", label: "median", value: dist.median, color: "var(--text)", w: 1.1 },
    { key: "p75", label: "p75", value: dist.p75, color: "var(--accent)", w: 0.7 },
    { key: "p90", label: "p90", value: dist.p90, color: "var(--accent-2)", w: 0.9 },
  ];
  return (
    <div>
      <svg
        viewBox="0 0 100 16"
        preserveAspectRatio="none"
        className="block h-9 w-full"
        role="img"
        aria-label="value distribution strip"
      >
        <rect x="0" y="7" width="100" height="2" fill="var(--track)" />
        <rect
          x={boxLo}
          y="3.5"
          width={Math.max(boxHi - boxLo, 0.6)}
          height="9"
          rx="1"
          fill="var(--accent)"
          opacity="0.28"
        />
        {marks.map((m) => (
          <rect
            key={m.key}
            x={Math.min(x(m.value), 100 - m.w)}
            y={m.key === "median" ? 1.5 : 3.5}
            width={m.w}
            height={m.key === "median" ? 13 : 9}
            fill={m.color}
          />
        ))}
      </svg>
      <div className="stat mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim">
        <span>min {fmtValue(dist.min, dist.unit)}</span>
        {marks.map((m) => (
          <span key={m.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-[3px] rounded-sm"
              style={{ background: m.color }}
            />
            {m.label} <span className="text-ink">{fmtValue(m.value, dist.unit)}</span>
          </span>
        ))}
        <span>max {fmtValue(dist.max, dist.unit)}</span>
      </div>
    </div>
  );
}
