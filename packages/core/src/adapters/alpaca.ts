/*
  Alpaca Market Data v2 — US equities/ETF minute bars.

  GET /v2/stocks/<SYMBOL>/bars?timeframe=1Min&…&sort=asc with the account's
  key pair in headers; responses paginate via next_page_token. Bar times
  arrive as RFC3339 strings and are converted to UTC epoch ms. The free
  tier serves the IEX feed; SIP needs a paid data subscription on the
  account — check Alpaca's own pricing page for terms.

  Env (BYO keys — read from the environment, never logged, never stored):
    ALPACA_KEY_ID, ALPACA_SECRET_KEY

  adapterOptions:
    {
      "feed": "iex",          // or "sip" if your subscription includes it
      "start": "2016-01-01"   // first-sync lower bound (UTC date) when no watermark exists
    }
*/
import { z } from "zod";
import type { BarRow } from "../store/store";
import { clampBars, fetchWithRetry, finiteNum, inBatches, require1m, sleep } from "./shared";
import type { Adapter, AdapterContext, FetchRequest } from "./types";

const optionsSchema = z.object({
  feed: z.enum(["iex", "sip"]).default("iex"),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use an ISO date like 2016-01-01")
    .default("2016-01-01"),
});

const API_BASE = "https://data.alpaca.markets/v2/stocks";
const PAGE_LIMIT = 10_000;
/** Stay comfortably under the free tier's requests-per-minute budget. */
const PACE_MS = 350;

export function alpacaBarsUrl(
  symbol: string,
  startIso: string,
  endIso: string,
  feed: string,
  pageToken: string | null,
): string {
  const p = new URLSearchParams({
    timeframe: "1Min",
    start: startIso,
    end: endIso,
    limit: String(PAGE_LIMIT),
    adjustment: "raw",
    feed,
    sort: "asc",
  });
  if (pageToken !== null) p.set("page_token", pageToken);
  return `${API_BASE}/${symbol}/bars?${p.toString()}`;
}

/** Auth headers from env — names only ever appear in code and errors, values never leave the request. */
export function alpacaHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const keyId = env.ALPACA_KEY_ID;
  const secret = env.ALPACA_SECRET_KEY;
  if (keyId === undefined || secret === undefined) {
    throw new Error(
      "alpaca: missing env ALPACA_KEY_ID / ALPACA_SECRET_KEY — export both in your shell; keys stay on your box",
    );
  }
  return { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
}

export interface AlpacaPage {
  bars: BarRow[];
  nextPageToken: string | null;
}

/** Parse one bars page: { bars: [{t,o,h,l,c,v,…}], next_page_token }. */
export function parseAlpacaBars(payload: unknown, symbol: string, tf: string): AlpacaPage {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(
      "alpaca: unexpected bars response (expected a JSON object) — API shape drifted, please open an issue",
    );
  }
  const obj = payload as { bars?: unknown; next_page_token?: unknown };
  const rawBars = obj.bars ?? []; // alpaca sends null for an empty range
  if (rawBars !== null && !Array.isArray(rawBars)) {
    throw new Error("alpaca: 'bars' is not an array — API shape drifted, please open an issue");
  }
  const bars = (rawBars ?? []).map((b: unknown) => {
    const bar = b as Record<string, unknown>;
    const t = bar.t;
    if (typeof t !== "string") {
      throw new Error(
        "alpaca: bar has no RFC3339 't' field — API shape drifted, please open an issue",
      );
    }
    const ts = Date.parse(t);
    if (Number.isNaN(ts)) throw new Error(`alpaca: unparseable bar time '${t}'`);
    return {
      symbol,
      tf,
      ts,
      open: finiteNum(bar.o, "open", "alpaca"),
      high: finiteNum(bar.h, "high", "alpaca"),
      low: finiteNum(bar.l, "low", "alpaca"),
      close: finiteNum(bar.c, "close", "alpaca"),
      volume: finiteNum(bar.v, "volume", "alpaca"),
      contract: null,
    };
  });
  const token = obj.next_page_token;
  return {
    bars,
    nextPageToken: typeof token === "string" && token.length > 0 ? token : null,
  };
}

export const alpacaAdapter: Adapter = {
  id: "alpaca",
  title: "Alpaca stocks/ETF minute bars",
  doc: "US equities/ETF minute bars from Alpaca Market Data v2 (free tier: IEX feed). Bring your own key pair via ALPACA_KEY_ID / ALPACA_SECRET_KEY.",
  requiresEnv: ["ALPACA_KEY_ID", "ALPACA_SECRET_KEY"],
  async *fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]> {
    const opts = optionsSchema.parse(ctx.symbol.adapterOptions);
    require1m("alpaca", ctx.symbol.tf);
    const { symbol, tf } = ctx.symbol;
    const headers = alpacaHeaders(ctx.env);
    const until = req.untilMs;

    let cursor = req.sinceMs ?? Date.parse(`${opts.start}T00:00:00Z`) - 1;
    if (cursor >= until) return;
    const startIso = new Date(cursor + 1).toISOString();
    const endIso = new Date(until).toISOString();

    let pageToken: string | null = null;
    let pulled = 0;
    for (;;) {
      const res = await fetchWithRetry(
        alpacaBarsUrl(symbol, startIso, endIso, opts.feed, pageToken),
        {
          what: "alpaca bars",
          init: { headers },
          authHint:
            "check ALPACA_KEY_ID / ALPACA_SECRET_KEY, and that your data subscription includes the requested feed",
        },
      );
      const page = parseAlpacaBars(await res.json(), symbol, tf);
      const bars = clampBars(page.bars, cursor, until);
      if (bars.length > 0) {
        yield* inBatches(bars);
        cursor = bars[bars.length - 1]?.ts ?? cursor;
        pulled += bars.length;
      }
      if (page.nextPageToken === null) break;
      pageToken = page.nextPageToken;
      await sleep(PACE_MS);
    }
    ctx.log(`alpaca: ${symbol} (${opts.feed}) → ${pulled} bars`);
  },
};
