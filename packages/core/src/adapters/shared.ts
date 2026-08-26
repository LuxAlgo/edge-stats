/*
  Shared plumbing for the vendor adapters: polite fetch with bounded
  retries, epoch normalization across vendor timestamp units, and the
  batch discipline every adapter owes the sync loop — strictly-ascending
  bars, inside (sinceMs, untilMs], ≤ 50k rows per yield.

  Nothing here logs or stores key material. Errors mention env var NAMES
  only, never values.
*/
import type { BarRow } from "../store/store";

/** Sync ingests per yield; 50k rows ≈ a month of 1-minute bars with headroom. */
export const MAX_BATCH_ROWS = 50_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchRetryOptions {
  /** Label for error messages, e.g. "binance klines". */
  what: string;
  init?: RequestInit;
  /** Statuses handed back to the caller instead of thrown (e.g. 404 = "archive not published yet"). */
  allowStatuses?: number[];
  /** Appended to 401/403 errors: which env var NAMES to check. Never values. */
  authHint?: string;
  /** Retries after the first attempt (429/5xx/network errors only). */
  retries?: number;
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt;
}

/**
 * fetch with bounded exponential backoff. 429/5xx/network errors retry up
 * to `retries` times; other 4xx fail hard immediately — retrying a bad
 * request or a bad key only burns rate limit.
 */
export async function fetchWithRetry(url: string, opts: FetchRetryOptions): Promise<Response> {
  const retries = opts.retries ?? 3;
  const host = new URL(url).host;
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, opts.init);
    } catch (err) {
      lastError = `network error (${err instanceof Error ? err.message : String(err)})`;
      if (attempt < retries) await sleep(backoffMs(attempt));
      continue;
    }
    if (res.ok || opts.allowStatuses?.includes(res.status) === true) return res;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `${opts.what}: HTTP ${res.status} from ${host} — ` +
          `${opts.authHint ?? "check your credentials"}; keys stay on your box and never belong in configs or logs`,
      );
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      if (attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const hinted = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
        await sleep(Math.max(backoffMs(attempt), hinted));
      }
      continue;
    }
    const body = (await res.text()).slice(0, 200);
    throw new Error(`${opts.what}: HTTP ${res.status} from ${host}${body ? ` — ${body}` : ""}`);
  }
  throw new Error(
    `${opts.what}: giving up after ${retries + 1} attempts — last error: ${lastError}`,
  );
}

/**
 * Vendors disagree on epoch units: coinbase sends seconds, binance archives
 * moved from milliseconds to MICROseconds in newer files, Massive flat
 * files use nanoseconds. Magnitude disambiguates unambiguously for any
 * market timestamp (1973 – ~year 5000):
 *   < 1e11 → seconds, < 1e14 → millis, < 1e17 → micros, else nanos.
 */
export function normalizeEpochToMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`unparseable epoch timestamp: ${String(value)}`);
  }
  if (value < 1e11) return Math.floor(value * 1000);
  if (value < 1e14) return Math.floor(value);
  if (value < 1e17) return Math.floor(value / 1e3);
  return Math.floor(value / 1e6);
}

/**
 * Same normalization for string fields. Micro/nano magnitudes exceed
 * Number.MAX_SAFE_INTEGER, where float truncation can skew a bar time by
 * a millisecond — those go through BigInt so the division stays exact.
 */
export function epochStrToMs(raw: string): number {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`unparseable epoch timestamp: '${raw}'`);
    return normalizeEpochToMs(n);
  }
  if (s.length <= 14) return normalizeEpochToMs(Number(s)); // seconds or millis: exact as float
  if (s.length <= 17) return Number(BigInt(s) / 1_000n); // microseconds
  return Number(BigInt(s) / 1_000_000n); // nanoseconds
}

/** Strict numeric field parse — a NaN must never reach the store. */
export function finiteNum(raw: unknown, what: string, context: string): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${context}: unparseable ${what} '${String(raw)}'`);
  return n;
}

/**
 * Watermark discipline in one place: sort ascending, drop duplicates, keep
 * only (afterMs, untilMs]. Adapters run every chunk through this with
 * their running cursor before yielding.
 */
export function clampBars(bars: BarRow[], afterMs: number | null, untilMs: number): BarRow[] {
  const sorted = bars.slice().sort((a, b) => a.ts - b.ts);
  const out: BarRow[] = [];
  let prev = afterMs ?? Number.NEGATIVE_INFINITY;
  for (const bar of sorted) {
    if (bar.ts <= prev || bar.ts > untilMs) continue;
    out.push(bar);
    prev = bar.ts;
  }
  return out;
}

/** Split rows into ≤ `max` yields (the sync loop ingests per batch). */
export function* inBatches(rows: BarRow[], max = MAX_BATCH_ROWS): Generator<BarRow[]> {
  for (let i = 0; i < rows.length; i += max) {
    yield rows.slice(i, i + max);
  }
}

/** The vendor endpoints wired up here serve 1-minute bars only. */
export function require1m(adapterId: string, tf: string): void {
  if (tf !== "1m") {
    throw new Error(
      `${adapterId}: pulls 1-minute bars only (got tf '${tf}') — set "tf": "1m" for this symbol`,
    );
  }
}
