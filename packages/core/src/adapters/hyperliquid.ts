/*
  Hyperliquid perp candles — keyless crypto minute bars from the public
  info endpoint.

  POST https://api.hyperliquid.xyz/info
    { "type": "candleSnapshot",
      "req": { "coin": "BTC", "interval": "1m", "startTime": ms, "endTime": ms } }
  answers with candle objects { t, T, s, i, o, c, h, l, v, n } where t is
  the bar-open time in ms and o/h/l/c/v arrive as strings.

  The endpoint only serves the most recent ~5000 candles per interval, so
  1-minute history reaches back about 3.5 days. This adapter is therefore
  a TAIL source: a daily `edgestats sync` accumulates history forward from
  first sync, and it covers perp symbols no spot exchange lists. For deep
  1m backfill use `lse` or `binance` and let hyperliquid keep it fresh.

  adapterOptions:
    {
      "coin": "BTC"   // hyperliquid coin name when it differs from the store symbol
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
  coin: z.string().min(1).optional(),
});

const API_URL = "https://api.hyperliquid.xyz/info";
/** The endpoint's per-request candle cap (and its total retention per interval). */
const WINDOW_BARS = 5000;
const MIN_MS = 60_000;
const PACE_MS = 300;

export function hyperliquidCandleBody(coin: string, startMs: number, endMs: number): string {
  return JSON.stringify({
    type: "candleSnapshot",
    req: { coin, interval: "1m", startTime: startMs, endTime: endMs },
  });
}

/** Parse a candleSnapshot payload ({t,o,h,l,c,v} objects, numerics as strings) into ascending BarRows. */
export function parseHyperliquidCandles(payload: unknown, symbol: string, tf: string): BarRow[] {
  if (!Array.isArray(payload)) {
    throw new Error(
      "hyperliquid: unexpected candleSnapshot response (expected a JSON array) — API shape drifted, please open an issue",
    );
  }
  const rows = payload.map((c: unknown) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      throw new Error(
        "hyperliquid: candle is not an object — API shape drifted, please open an issue",
      );
    }
    const row = c as Record<string, unknown>;
    return {
      symbol,
      tf,
      ts: normalizeEpochToMs(finiteNum(row.t, "t", "hyperliquid")),
      open: finiteNum(row.o, "open", "hyperliquid"),
      high: finiteNum(row.h, "high", "hyperliquid"),
      low: finiteNum(row.l, "low", "hyperliquid"),
      close: finiteNum(row.c, "close", "hyperliquid"),
      volume: finiteNum(row.v, "volume", "hyperliquid"),
      contract: null,
    };
  });
  return rows.sort((a, b) => a.ts - b.ts);
}

export const hyperliquidAdapter: Adapter = {
  id: "hyperliquid",
  title: "Hyperliquid perp candles",
  doc: "Keyless perp minute bars from the public Hyperliquid info endpoint. The venue serves only the most recent ~5000 candles per interval, so this is a tail source: daily syncs accumulate history forward, and lse or binance backfill the deep past.",
  requiresEnv: [],
  async *fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]> {
    const opts = optionsSchema.parse(ctx.symbol.adapterOptions);
    require1m("hyperliquid", ctx.symbol.tf);
    const { symbol, tf } = ctx.symbol;
    const coin = opts.coin ?? symbol;
    const until = req.untilMs;

    // No watermark: the venue only holds ~5000 minutes anyway, so the
    // first sync starts at the edge of what it can serve.
    let cursor = req.sinceMs ?? until - WINDOW_BARS * MIN_MS;
    let pulled = 0;
    while (cursor < until) {
      const windowEnd = Math.min(until, cursor + WINDOW_BARS * MIN_MS);
      const res = await fetchWithRetry(API_URL, {
        what: "hyperliquid candleSnapshot",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: hyperliquidCandleBody(coin, cursor + 1, windowEnd),
        },
      });
      const bars = clampBars(parseHyperliquidCandles(await res.json(), symbol, tf), cursor, until);
      if (bars.length > 0) {
        yield* inBatches(bars);
        pulled += bars.length;
      }
      // Advance past the window even when it came back empty: minutes
      // older than the venue's retention are gone, not still pending.
      cursor = windowEnd;
      if (cursor < until) await sleep(PACE_MS);
    }
    ctx.log(`hyperliquid: ${symbol} → ${pulled} bars`);
  },
};
