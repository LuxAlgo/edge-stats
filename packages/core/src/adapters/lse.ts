/*
  London Strategic Edge vault candles — free multi-asset minute bars with
  one free API key (stocks, FX, crypto, commodities, indices, ETFs,
  futures; US stocks back to 2003, FX to 2009, crypto to 2017).

  GET https://api.londonstrategicedge.com/vault/candles
      ?symbol=EUR/USD&timeframe=1m&order=asc&limit=5000&start=&end=
  with the key in an `x-api-key` header. Rows arrive as objects carrying
  the bar-open time (`ts` or `timestamp`, epoch or ISO) plus open, high,
  low, close, and volume (FX candles carry no consolidated volume; 0).
  5000 rows per call; the fetch loop pages forward from the watermark by
  asking each page to start just after the last bar it saw.

  adapterOptions:
    {
      "lseSymbol": "EUR/USD",  // vault symbol when it differs from the store symbol
      "start": "2009-01-01",   // first-sync lower bound when no watermark exists
      "dataset": "fx"          // optional class pin when a symbol exists in several
    }

  Env: LSE_API_KEY (free key from londonstrategicedge.com/data).
*/
import { z } from "zod";
import type { BarRow } from "../store/store";
import {
  clampBars,
  fetchWithRetry,
  finiteNum,
  inBatches,
  normalizeEpochToMs,
  require1m,
  sleep,
} from "./shared";
import type { Adapter, AdapterContext, FetchRequest } from "./types";

const optionsSchema = z.object({
  lseSymbol: z.string().min(1).optional(),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use an ISO date like 2009-01-01")
    .default("2009-01-01"),
  dataset: z.string().min(1).optional(),
});

const API_BASE = "https://api.londonstrategicedge.com/vault";
/** The vault's per-call row cap. */
const PAGE_LIMIT = 5000;
/** Polite pacing; streaming and download share one keyed allowance. */
const PACE_MS = 250;

export function lseCandlesUrl(
  symbol: string,
  startIso: string,
  untilIso: string,
  dataset?: string,
): string {
  const p = new URLSearchParams({
    symbol,
    timeframe: "1m",
    order: "asc",
    limit: String(PAGE_LIMIT),
    start: startIso,
    end: untilIso,
  });
  if (dataset !== undefined) p.set("dataset", dataset);
  return `${API_BASE}/candles?${p.toString()}`;
}

/** The bar-open time arrives as `ts` or `timestamp`, epoch (s or ms) or ISO. */
function rowTs(row: Record<string, unknown>): number {
  const raw = row.ts ?? row.timestamp;
  if (typeof raw === "number") return normalizeEpochToMs(raw);
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    return normalizeEpochToMs(finiteNum(raw, "ts", "lse"));
  }
  throw new Error("lse: candle row has no ts/timestamp — API shape drifted, please open an issue");
}

/** Parse a vault candles payload (array of row objects) into ascending BarRows. */
export function parseLseCandles(payload: unknown, symbol: string, tf: string): BarRow[] {
  if (!Array.isArray(payload)) {
    throw new Error(
      "lse: unexpected candles response (expected a JSON array) — API shape drifted, please open an issue",
    );
  }
  const rows = payload.map((r: unknown) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      throw new Error("lse: candle row is not an object — API shape drifted, please open an issue");
    }
    const row = r as Record<string, unknown>;
    return {
      symbol,
      tf,
      ts: rowTs(row),
      open: finiteNum(row.open, "open", "lse"),
      high: finiteNum(row.high, "high", "lse"),
      low: finiteNum(row.low, "low", "lse"),
      close: finiteNum(row.close, "close", "lse"),
      volume:
        row.volume === undefined || row.volume === null
          ? 0
          : finiteNum(row.volume, "volume", "lse"),
      contract: null,
    };
  });
  return rows.sort((a, b) => a.ts - b.ts);
}

export const lseAdapter: Adapter = {
  id: "lse",
  title: "London Strategic Edge vault",
  doc: "Free multi-asset minute bars (stocks, FX, crypto, commodities, indices, ETFs, futures) from the London Strategic Edge vault, paginated 5000 candles per call from the watermark forward. One free API key.",
  requiresEnv: ["LSE_API_KEY"],
  async *fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]> {
    const opts = optionsSchema.parse(ctx.symbol.adapterOptions);
    require1m("lse", ctx.symbol.tf);
    const apiKey = ctx.env.LSE_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        "lse: missing env LSE_API_KEY — get a free key at londonstrategicedge.com/data and export it in your shell; keys stay on your box",
      );
    }
    const { symbol, tf } = ctx.symbol;
    const vaultSymbol = opts.lseSymbol ?? symbol;
    const until = req.untilMs;
    const untilIso = new Date(until).toISOString();

    let cursor = req.sinceMs ?? Date.parse(`${opts.start}T00:00:00Z`) - 1;
    let pulled = 0;
    for (;;) {
      const url = lseCandlesUrl(
        vaultSymbol,
        new Date(cursor + 1).toISOString(),
        untilIso,
        opts.dataset,
      );
      const res = await fetchWithRetry(url, {
        what: "lse candles",
        init: { headers: { "x-api-key": apiKey } },
        authHint: "check LSE_API_KEY",
      });
      const page = parseLseCandles(await res.json(), symbol, tf);
      const bars = clampBars(page, cursor, until);
      if (bars.length > 0) {
        yield* inBatches(bars);
        pulled += bars.length;
        const lastTs = bars[bars.length - 1]?.ts;
        if (lastTs !== undefined) cursor = lastTs;
      }
      // A short page means the vault has nothing further before `until`.
      if (page.length < PAGE_LIMIT) break;
      await sleep(PACE_MS);
    }
    ctx.log(`lse: ${symbol} → ${pulled} bars`);
  },
};
