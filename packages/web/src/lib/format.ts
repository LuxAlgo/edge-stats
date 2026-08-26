/*
  Formatting helpers. Percentages here always come from an Estimate-shaped
  context (estimate + CI + N travel together); this module only turns
  numbers into strings, it never decides what may be shown.
*/

export function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** "81.6–87.9%" — one unit sign for the pair, en dash between. */
export function fmtCiRange(ci: [number, number], digits = 1): string {
  return `${(ci[0] * 100).toFixed(digits)}–${(ci[1] * 100).toFixed(digits)}%`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtNum(x: number, maxDigits = 2): string {
  if (Number.isInteger(x)) return x.toLocaleString("en-US");
  return x.toLocaleString("en-US", { maximumFractionDigits: maxDigits });
}

/** A continuous outcome value with its unit ("12m", "0.42%", "1.5 r"). */
export function fmtValue(x: number, unit: string): string {
  if (unit === "minutes") return `${fmtNum(x, 1)}m`;
  if (unit === "%") return `${fmtNum(x, 2)}%`;
  if (unit === "") return fmtNum(x, 2);
  return `${fmtNum(x, 2)} ${unit}`;
}

/** Relative time for freshness hints: "4h ago", "12d ago". */
export function relTime(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms)) return "unknown";
  const diff = now - ms;
  if (diff < 0) return "in the future";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 90) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Days from now until an ISO date (negative = already past). */
export function daysUntil(isoDate: string, now = Date.now()): number {
  return Math.floor((Date.parse(isoDate) - now) / 86_400_000);
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/*
  The envelope's own disclaimer renders verbatim wherever a QueryResult is
  shown. Live Board setups carry no envelope, so their footnote mirrors the
  engine's DISCLAIMER constant (core/src/query/execute.ts): keep in sync.
*/
export const LIVE_FOOTNOTE =
  "Historical conditional frequencies with sample sizes. Not predictions, not advice.";
