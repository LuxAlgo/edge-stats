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

/* Landing discipline: scale carries hierarchy, weight stays medium. */
const sizeClasses = {
  xl: "text-6xl font-medium tracking-tight",
  lg: "text-4xl font-medium tracking-tight",
  md: "text-3xl font-medium tracking-tight",
  sm: "text-xl font-medium tracking-tight",
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
        {label ? <div className="mb-1.5 text-xs text-muted-foreground">{label}</div> : null}
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className={`${sizeClasses[size]} text-faint`}>N too small</span>
          <NBadge n={n} />
        </div>
        <div className="stat mt-1.5 font-mono text-xs text-faint">
          {n === 0 ? "no matching sessions" : `${fmtInt(n)} matched: estimate withheld`}
        </div>
      </div>
    );
  }

  return (
    <div>
      {label ? <div className="mb-1.5 text-xs text-muted-foreground">{label}</div> : null}
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className={`stat ${sizeClasses[size]}`}>{fmtPct(estimate)}</span>
        <NBadge n={n} />
        {lowSample ? <LowSampleBadge /> : null}
      </div>
      <div className="stat mt-1.5 font-mono text-xs text-muted-foreground">
        95% CI {fmtCiRange(ci95)}
      </div>
    </div>
  );
}

/** Inline variant for table rows: estimate · CI · N on one line, same contract. */
export function EstimateInline({ facts }: { facts: EstimateFacts }) {
  const { estimate, ci95, n, lowSample } = facts;
  if (estimate === null || ci95 === null) {
    return (
      <span className="stat inline-flex items-center gap-2 text-sm text-faint">
        N too small <NBadge n={n} />
      </span>
    );
  }
  return (
    <span className="stat inline-flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{fmtPct(estimate)}</span>
      <span className="font-mono text-xs text-muted-foreground">CI {fmtCiRange(ci95)}</span>
      <NBadge n={n} />
      {lowSample ? <LowSampleBadge /> : null}
    </span>
  );
}
