/*
  Coercion helpers for values coming back from DuckDB. Counts arrive as
  BigInt, decimals as value objects, dates as driver-specific wrappers —
  the executor casts to VARCHAR/DOUBLE/INT in SQL where it matters and
  these helpers absorb whatever remains.
*/

export function asNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(String(v));
  return Number.isNaN(n) ? null : n;
}

export function asInt(v: unknown): number | null {
  const n = asNum(v);
  return n === null ? null : Math.trunc(n);
}

export function asStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

export function asBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "number") return v !== 0;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return null;
}

export function round(v: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
