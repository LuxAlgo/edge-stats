/*
  Binance spot klines — free, keyless crypto history.

  Bulk path first: data.binance.vision publishes completed months (and
  completed days for the not-yet-archived stub) of 1-minute klines as
  ZIP'd CSVs; the last few hours come from the plain REST klines endpoint,
  paginated 1000 bars per call. No account, no key, no cost.

  Archive CSV columns: openTime, open, high, low, close, volume,
  closeTime, … (extras ignored). Newer archives switched openTime to
  MICROseconds and grew a header row — both are detected and normalized
  (magnitude ⇒ unit, non-digit first field ⇒ header).

  Archives 404 both before a symbol's listing and after the publication
  lag at the live edge; the REST tail absorbs both ends.

  api.binance.com refuses some regions (HTTP 451) — notably US-hosted CI
  runners — while data.binance.vision is a plain CDN that serves anywhere.
  For those environments set both options below: `start` skips the REST
  first-listing probe and `archiveOnly` skips the REST live tail, so every
  request goes to the archive host and history simply ends at the newest
  published daily archive (about a day behind).

  adapterOptions:
    {
      "market": "spot",       // only the spot archives are wired up today
      "start": "2020-01-01",  // first-sync lower bound; skips the REST listing probe
      "archiveOnly": false    // true = never call api.binance.com (archive host only)
    }
*/
import { strFromU8, unzipSync } from "fflate";
import { DateTime } from "luxon";
import { z } from "zod";
import type { BarRow } from "../store/store";
import {
  clampBars,
  epochStrToMs,
  fetchWithRetry,
  finiteNum,
  inBatches,
  normalizeEpochToMs,
  require1m,
  sleep,
} from "./shared";
import type { Adapter, AdapterContext, FetchRequest } from "./types";

const optionsSchema = z.object({
  market: z.enum(["spot"]).default("spot"),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use an ISO date like 2020-01-01")
    .optional(),
  archiveOnly: z.boolean().default(false),
});

const ARCHIVE_BASE = "https://data.binance.vision/data";
const REST_BASE = "https://api.binance.com/api/v3/klines";
const REST_PAGE_LIMIT = 1000;
/** Politeness pause between calls — these endpoints are keyless; don't hammer them. */
const PACE_MS = 150;

export function binanceMonthlyUrl(
  market: string,
  symbol: string,
  year: number,
  month: number,
): string {
  const mm = String(month).padStart(2, "0");
  return `${ARCHIVE_BASE}/${market}/monthly/klines/${symbol}/1m/${symbol}-1m-${year}-${mm}.zip`;
}

export function binanceDailyUrl(market: string, symbol: string, isoDate: string): string {
  return `${ARCHIVE_BASE}/${market}/daily/klines/${symbol}/1m/${symbol}-1m-${isoDate}.zip`;
}

export function binanceRestUrl(
  symbol: string,
  startTimeMs: number,
  limit = REST_PAGE_LIMIT,
): string {
  const p = new URLSearchParams({
    symbol,
    interval: "1m",
    startTime: String(startTimeMs),
    limit: String(limit),
  });
  return `${REST_BASE}?${p.toString()}`;
}

/** Unzip a data.binance.vision kline archive (a single CSV entry) in memory. */
export function unzipBinanceKlines(zipBytes: Uint8Array): string {
  const entries = unzipSync(zipBytes);
  const name = Object.keys(entries).find((n) => n.endsWith(".csv"));
  const data = name === undefined ? undefined : entries[name];
  if (data === undefined) {
    throw new Error(
      `binance: archive holds no CSV (entries: ${Object.keys(entries).join(", ") || "none"}) — archive layout drifted, please open an issue`,
    );
  }
  return strFromU8(data);
}

/**
 * Parse an archive CSV. Older files have no header; newer ones do (skipped
 * by the non-digit first field). openTime magnitude decides ms vs µs.
 */
export function parseBinanceKlineCsv(text: string, symbol: string, tf: string): BarRow[] {
  const rows: BarRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split(",");
    const first = parts[0];
    if (first === undefined || !/^\d/.test(first)) continue; // header row in newer archives
    if (parts.length < 6) {
      throw new Error(
        `binance: kline row has ${parts.length} columns, expected ≥ 6 — archive format drifted, please open an issue`,
      );
    }
    rows.push({
      symbol,
      tf,
      ts: epochStrToMs(first),
      open: finiteNum(parts[1], "open", "binance"),
      high: finiteNum(parts[2], "high", "binance"),
      low: finiteNum(parts[3], "low", "binance"),
      close: finiteNum(parts[4], "close", "binance"),
      volume: finiteNum(parts[5], "volume", "binance"),
      contract: null,
    });
  }
  return rows;
}

/** Parse the REST /api/v3/klines payload (array of arrays, openTime first). */
export function parseBinanceRestKlines(payload: unknown, symbol: string, tf: string): BarRow[] {
  if (!Array.isArray(payload)) {
    throw new Error(
      "binance: unexpected klines response (expected a JSON array) — API shape drifted, please open an issue",
    );
  }
  return payload.map((k: unknown) => {
    if (!Array.isArray(k) || k.length < 6) {
      throw new Error(
        "binance: kline entry is not [openTime, open, high, low, close, volume, …] — API shape drifted, please open an issue",
      );
    }
    return {
      symbol,
      tf,
      ts: normalizeEpochToMs(finiteNum(k[0], "openTime", "binance")),
      open: finiteNum(k[1], "open", "binance"),
      high: finiteNum(k[2], "high", "binance"),
      low: finiteNum(k[3], "low", "binance"),
      close: finiteNum(k[4], "close", "binance"),
      volume: finiteNum(k[5], "volume", "binance"),
      contract: null,
    };
  });
}

async function fetchArchive(url: string): Promise<Uint8Array | null> {
  const res = await fetchWithRetry(url, { what: "binance archive", allowStatuses: [404] });
  if (res.status === 404) return null;
  return new Uint8Array(await res.arrayBuffer());
}

export const binanceAdapter: Adapter = {
  id: "binance",
  title: "Binance spot klines",
  doc: "Free, keyless crypto minute bars: bulk monthly/daily ZIP archives from data.binance.vision, then the public REST klines endpoint for the live tail.",
  requiresEnv: [],
  async *fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]> {
    const opts = optionsSchema.parse(ctx.symbol.adapterOptions);
    require1m("binance", ctx.symbol.tf);
    const { symbol, tf } = ctx.symbol;
    const until = req.untilMs;

    // No watermark yet → ask REST for the very first kline (startTime=0
    // returns history's start), so the month loop begins at listing
    // instead of walking 404s from 2017.
    let cursor: number; // exclusive lower bound of what we still owe
    if (req.sinceMs !== null) {
      cursor = req.sinceMs;
    } else if (opts.start !== undefined) {
      cursor = Date.parse(`${opts.start}T00:00:00Z`) - 1;
    } else {
      const res = await fetchWithRetry(binanceRestUrl(symbol, 0, 1), { what: "binance klines" });
      const first = parseBinanceRestKlines(await res.json(), symbol, tf)[0];
      if (first === undefined) {
        ctx.log(`binance: no history for ${symbol} — check the symbol spelling (e.g. BTCUSDT)`);
        return;
      }
      cursor = first.ts - 1;
      ctx.log(`binance: ${symbol} history starts ${new Date(first.ts).toISOString()}`);
    }
    if (cursor >= until) return;

    // 1) Whole months from the bulk archive. Months entirely at or below
    //    the watermark are skipped without a request.
    let month = DateTime.fromMillis(cursor + 1, { zone: "utc" }).startOf("month");
    while (month.toMillis() <= until) {
      const monthEndMs = month.plus({ months: 1 }).toMillis() - 1;
      if (monthEndMs <= cursor) {
        month = month.plus({ months: 1 });
        continue;
      }
      const zip = await fetchArchive(
        binanceMonthlyUrl(opts.market, symbol, month.year, month.month),
      );
      if (zip === null) break; // not published yet (or pre-listing) — fall through to daily
      const bars = clampBars(
        parseBinanceKlineCsv(unzipBinanceKlines(zip), symbol, tf),
        cursor,
        until,
      );
      if (bars.length > 0) yield* inBatches(bars);
      // A published monthly archive covers its whole month — advance past it
      // even when the tail bars were sparse, so the daily loop starts fresh.
      cursor = Math.max(cursor, Math.min(monthEndMs, until));
      ctx.log(
        `binance: ${symbol} ${month.toFormat("yyyy-MM")} monthly archive → ${bars.length} bars`,
      );
      month = month.plus({ months: 1 });
      await sleep(PACE_MS);
    }

    // 2) Whole days for the recent stub the monthly archive hasn't caught up to.
    let day = DateTime.fromMillis(cursor + 1, { zone: "utc" }).startOf("day");
    while (day.toMillis() <= until) {
      const isoDate = day.toISODate();
      if (isoDate === null) break;
      const zip = await fetchArchive(binanceDailyUrl(opts.market, symbol, isoDate));
      if (zip === null) break; // today/yesterday not published yet — REST covers the rest
      const bars = clampBars(
        parseBinanceKlineCsv(unzipBinanceKlines(zip), symbol, tf),
        cursor,
        until,
      );
      if (bars.length > 0) yield* inBatches(bars);
      // Same as monthly: a published daily archive covers its whole day.
      cursor = Math.max(cursor, Math.min(day.plus({ days: 1 }).toMillis() - 1, until));
      ctx.log(`binance: ${symbol} ${isoDate} daily archive → ${bars.length} bars`);
      day = day.plus({ days: 1 });
      await sleep(PACE_MS);
    }

    // 3) REST tail to the live edge, 1000 bars per page. archiveOnly stops
    //    at the newest published daily archive instead (regions where
    //    api.binance.com answers 451).
    if (opts.archiveOnly) {
      ctx.log(`binance: ${symbol} archiveOnly — tail resumes with the next daily archive`);
      return;
    }
    while (cursor < until) {
      const res = await fetchWithRetry(binanceRestUrl(symbol, cursor + 1), {
        what: "binance klines",
      });
      const page = parseBinanceRestKlines(await res.json(), symbol, tf);
      if (page.length === 0) break;
      const bars = clampBars(page, cursor, until);
      if (bars.length > 0) yield* inBatches(bars);
      const lastRaw = page[page.length - 1];
      cursor = Math.max(cursor, lastRaw?.ts ?? cursor);
      if (lastRaw === undefined || lastRaw.ts >= until) break;
      if (page.length < REST_PAGE_LIMIT) break; // final partial page
      await sleep(PACE_MS);
    }
  },
};
