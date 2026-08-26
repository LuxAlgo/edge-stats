/*
  Coinbase Exchange candles — keyless crypto minute bars.

  GET /products/<PRODUCT-ID>/candles?granularity=60&start=&end= serves at
  most 300 candles per call, NEWEST-first, each row
  [time(sec), low, high, open, close, volume] — reordered ascending and
  converted sec → ms here. The fetch loop walks 300-minute windows forward
  from the watermark at ~3 requests/second (the public rate limit is
  tight; be polite).

  Deep history through this endpoint is slow by construction (300 bars per
  request). For years of backfill, import a flat file via the `csv`
  adapter once and let coinbase keep it fresh from there.

  adapterOptions:
    {
      "start": "2016-01-01"   // first-sync lower bound (UTC date) when no watermark exists
    }
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
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use an ISO date like 2016-01-01")
    .default("2016-01-01"),
});

const API_BASE = "https://api.exchange.coinbase.com";
const GRANULARITY_S = 60;
/** The endpoint's hard cap per request. */
const WINDOW_BARS = 300;
/** ~3 requests/second keeps us well under the public rate limit. */
const PACE_MS = 350;

export function coinbaseCandlesUrl(productId: string, startMs: number, endMs: number): string {
  const p = new URLSearchParams({
    granularity: String(GRANULARITY_S),
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  });
  return `${API_BASE}/products/${productId}/candles?${p.toString()}`;
}

/** Parse a candles payload: newest-first [time, low, high, open, close, volume] → ascending BarRows. */
export function parseCoinbaseCandles(payload: unknown, symbol: string, tf: string): BarRow[] {
  if (!Array.isArray(payload)) {
    throw new Error(
      "coinbase: unexpected candles response (expected a JSON array) — API shape drifted, please open an issue",
    );
  }
  const rows = payload.map((c: unknown) => {
    if (!Array.isArray(c) || c.length < 6) {
      throw new Error(
        "coinbase: candle is not [time, low, high, open, close, volume] — API shape drifted, please open an issue",
      );
    }
    return {
      symbol,
      tf,
      ts: normalizeEpochToMs(finiteNum(c[0], "time", "coinbase")),
      open: finiteNum(c[3], "open", "coinbase"),
      high: finiteNum(c[2], "high", "coinbase"),
      low: finiteNum(c[1], "low", "coinbase"),
      close: finiteNum(c[4], "close", "coinbase"),
      volume: finiteNum(c[5], "volume", "coinbase"),
      contract: null,
    };
  });
  return rows.sort((a, b) => a.ts - b.ts);
}

export const coinbaseAdapter: Adapter = {
  id: "coinbase",
  title: "Coinbase Exchange candles",
  doc: "Keyless crypto minute bars from the public Coinbase Exchange candles endpoint, paginated 300 candles per call from the watermark forward.",
  requiresEnv: [],
  async *fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]> {
    const opts = optionsSchema.parse(ctx.symbol.adapterOptions);
    require1m("coinbase", ctx.symbol.tf);
    const { symbol, tf } = ctx.symbol;
    const until = req.untilMs;

    // The config symbol IS the product id (e.g. BTC-USD).
    let cursor = req.sinceMs ?? Date.parse(`${opts.start}T00:00:00Z`) - 1;
    let pulled = 0;
    while (cursor < until) {
      const windowEnd = Math.min(until, cursor + WINDOW_BARS * GRANULARITY_S * 1000);
      const res = await fetchWithRetry(coinbaseCandlesUrl(symbol, cursor + 1, windowEnd), {
        what: "coinbase candles",
      });
      const bars = clampBars(parseCoinbaseCandles(await res.json(), symbol, tf), cursor, until);
      if (bars.length > 0) {
        yield* inBatches(bars);
        pulled += bars.length;
      }
      // Advance past the whole window even when it came back sparse or
      // empty (thin markets, pre-listing) — the span is covered either way.
      cursor = windowEnd;
      if (cursor < until) await sleep(PACE_MS);
    }
    ctx.log(`coinbase: ${symbol} → ${pulled} bars`);
  },
};
