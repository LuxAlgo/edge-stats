/*
  The statistical honesty layer. Every estimate the engine emits goes
  through here: Wilson intervals, minimum-N guards, first-half/second-half
  stability, and distribution summaries. No bare percentages leave the
  engine — including in marketing.
*/

export interface Wilson {
  estimate: number;
  lo: number;
  hi: number;
}

/** Wilson score interval for a binomial proportion (default 95%). */
export function wilson(k: number, n: number, z = 1.959963984540054): Wilson | null {
  if (n <= 0) return null;
  if (k < 0 || k > n) throw new Error(`impossible counts: k=${k} n=${n}`);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { estimate: p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export interface GuardResult {
  lowSample: boolean;
  refused: boolean;
  warnFloor: number;
  refuseFloor: number;
}

export function applyGuards(n: number, floors: { warn: number; refuse: number }): GuardResult {
  return {
    lowSample: n < floors.warn,
    refused: n < floors.refuse,
    warnFloor: floors.warn,
    refuseFloor: floors.refuse,
  };
}

export interface HalfStats {
  n: number;
  k: number;
  estimate: number | null;
  ci95: [number, number] | null;
}

export interface StabilitySplit {
  firstHalf: HalfStats;
  secondHalf: HalfStats;
  /** Wilson CIs overlap → the two halves are statistically compatible. Null when a half is empty. */
  agree: boolean | null;
}

function half(n: number, k: number): HalfStats {
  const w = wilson(k, n);
  return { n, k, estimate: w?.estimate ?? null, ci95: w ? [w.lo, w.hi] : null };
}

export function stabilitySplit(n1: number, k1: number, n2: number, k2: number): StabilitySplit {
  const firstHalf = half(n1, k1);
  const secondHalf = half(n2, k2);
  let agree: boolean | null = null;
  if (firstHalf.ci95 && secondHalf.ci95) {
    agree = firstHalf.ci95[0] <= secondHalf.ci95[1] && secondHalf.ci95[0] <= firstHalf.ci95[1];
  }
  return { firstHalf, secondHalf, agree };
}

export interface DistributionSummary {
  count: number;
  mean: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
  unit: string;
}

/** Build from DuckDB quantile_cont(v, [0, .25, .5, .75, .9, 1]) output. */
export function distributionFromQuantiles(
  count: number,
  mean: number,
  q: number[],
  unit: string,
): DistributionSummary | null {
  if (count <= 0 || q.length !== 6) return null;
  const [min, p25, median, p75, p90, max] = q as [number, number, number, number, number, number];
  return { count, mean, min, p25, median, p75, p90, max, unit };
}
