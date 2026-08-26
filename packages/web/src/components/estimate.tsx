/*
  The ONE component allowed to render a probability estimate. Its props
  require the estimate, the 95% CI, and N together: a bare percentage is
  unrepresentable in this codebase. When the engine withheld the number
  (below the refuse floor) it says "N too small" instead, honestly, and it
  carries the LOW SAMPLE flag whenever the guard raised it.
*/
import { fmtCiRange, fmtInt, fmtPct } from "../lib/format";
import { LowSampleBadge, NBadge } from "./ui";

export interface EstimateFacts {
  estimate: number | null;
  ci95: [number, number] | null;
  n: number;
  lowSample?: boolean;
}

const sizeClasses = {
  xl: "text-6xl font-semibold tracking-tight",
  lg: "text-4xl font-semibold tracking-tight",
  md: "text-3xl font-semibold tracking-tight",
  sm: "text-xl font-semibold",
} as const;

export function Estimate({
  facts,
  size = "md",
  label,
}: {
  facts: EstimateFacts;
  size?: keyof typeof sizeClasses;
  label?: string;
}) {
  const { estimate, ci95, n, lowSample } = facts;

  if (estimate === null || ci95 === null) {
    return (
      <div>
        {label ? <div className="mb-1 text-xs text-dim">{label}</div> : null}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={`${sizeClasses[size]} text-dim`}>N too small</span>
          <NBadge n={n} />
        </div>
        <div className="stat mt-1 text-xs text-dim">
          {n === 0 ? "no matching sessions" : `${fmtInt(n)} matched: estimate withheld`}
        </div>
      </div>
    );
  }

  return (
    <div>
      {label ? <div className="mb-1 text-xs text-dim">{label}</div> : null}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`stat ${sizeClasses[size]}`}>{fmtPct(estimate)}</span>
        <NBadge n={n} />
        {lowSample ? <LowSampleBadge /> : null}
      </div>
      <div className="stat mt-1 text-sm text-dim">95% CI {fmtCiRange(ci95)}</div>
    </div>
  );
}

/** Inline variant for table rows: estimate · CI · N on one line, same contract. */
export function EstimateInline({ facts }: { facts: EstimateFacts }) {
  const { estimate, ci95, n, lowSample } = facts;
  if (estimate === null || ci95 === null) {
    return (
      <span className="stat inline-flex items-center gap-2 text-sm text-dim">
        N too small <NBadge n={n} />
      </span>
    );
  }
  return (
    <span className="stat inline-flex flex-wrap items-center gap-2 text-sm">
      <span className="font-semibold">{fmtPct(estimate)}</span>
      <span className="text-dim">CI {fmtCiRange(ci95)}</span>
      <NBadge n={n} />
      {lowSample ? <LowSampleBadge /> : null}
    </span>
  );
}
