/*
  Alpaca adapter: RFC3339 → epoch-ms bar parsing, page_token pagination,
  header construction from env NAMES, and pinned request params. No
  network; no key value ever appears in a URL or an error.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alpacaAdapter,
  alpacaBarsUrl,
  alpacaHeaders,
  parseAlpacaBars,
} from "../../src/adapters/alpaca";
import { assertWatermarkDiscipline, collect, jsonResponse, makeCtx, stubFetch } from "./helpers";

const MIN = 60_000;
const T0 = Date.UTC(2024, 0, 2, 14, 30); // 2024-01-02T14:30Z — cash open, in UTC

function rawBar(tsMs: number, close: number) {
  return {
    t: new Date(tsMs).toISOString(),
    o: 470.1,
    h: 470.6,
    l: 469.9,
    c: close,
    v: 1200,
    n: 5,
    vw: 470.2,
  };
}

describe("bars page parsing", () => {
  it("converts RFC3339 't' to epoch ms and maps o/h/l/c/v", () => {
    const page = parseAlpacaBars(
      { bars: [rawBar(T0, 470.5)], symbol: "SPY", next_page_token: "tok123" },
      "SPY",
      "1m",
    );
    expect(page.bars).toEqual([
      {
        symbol: "SPY",
        tf: "1m",
        ts: T0,
        open: 470.1,
        high: 470.6,
        low: 469.9,
        close: 470.5,
        volume: 1200,
        contract: null,
      },
    ]);
    expect(page.nextPageToken).toBe("tok123");
  });

  it("treats a null/absent bars field as an empty page and empty token as done", () => {
    expect(parseAlpacaBars({ bars: null, next_page_token: null }, "SPY", "1m")).toEqual({
      bars: [],
      nextPageToken: null,
    });
    expect(parseAlpacaBars({}, "SPY", "1m").nextPageToken).toBeNull();
  });

  it("fails loudly when the bar shape drifts", () => {
    expect(() => parseAlpacaBars({ bars: [{ o: 1 }] }, "SPY", "1m")).toThrow(/drifted/);
    expect(() => parseAlpacaBars("nope", "SPY", "1m")).toThrow(/drifted/);
  });
});

describe("auth headers come from env NAMES; values never leak into URLs or errors", () => {
  it("builds the two APCA headers from ALPACA_KEY_ID / ALPACA_SECRET_KEY", () => {
    expect(alpacaHeaders({ ALPACA_KEY_ID: "id-abc", ALPACA_SECRET_KEY: "sec-xyz" })).toEqual({
      "APCA-API-KEY-ID": "id-abc",
      "APCA-API-SECRET-KEY": "sec-xyz",
    });
  });

  it("names the missing env vars without echoing the one that is set", () => {
    try {
      alpacaHeaders({ ALPACA_KEY_ID: "id-abc" });
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("ALPACA_KEY_ID");
      expect(msg).toContain("ALPACA_SECRET_KEY");
      expect(msg).not.toContain("id-abc");
    }
  });

  it("keeps auth out of the URL (headers only) and pins the query params", () => {
    const url = alpacaBarsUrl(
      "SPY",
      "2024-01-02T00:00:00.000Z",
      "2024-01-03T00:00:00.000Z",
      "iex",
      null,
    );
    expect(url).toBe(
      "https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Min&start=2024-01-02T00%3A00%3A00.000Z&end=2024-01-03T00%3A00%3A00.000Z&limit=10000&adjustment=raw&feed=iex&sort=asc",
    );
    expect(alpacaBarsUrl("SPY", "a", "b", "sip", "tok123")).toContain("feed=sip");
    expect(alpacaBarsUrl("SPY", "a", "b", "iex", "tok123")).toContain("page_token=tok123");
  });
});

describe("fetchBars follows page_token to the end", () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = { ALPACA_KEY_ID: "id-abc", ALPACA_SECRET_KEY: "sec-xyz" };

  it("paginates, sends headers on every call, and clamps to (since, until]", async () => {
    const sinceMs = T0;
    const untilMs = T0 + 5 * MIN;
    const { calls } = stubFetch((url) => {
      if (!url.includes("page_token")) {
        return jsonResponse({
          bars: [rawBar(T0, 470), rawBar(T0 + MIN, 471)], // T0 == since → clamped
          next_page_token: "page2",
        });
      }
      return jsonResponse({
        bars: [rawBar(T0 + 2 * MIN, 472), rawBar(T0 + 99 * MIN, 999)], // beyond until → clamped
        next_page_token: null,
      });
    });

    const ctx = makeCtx({ symbol: "SPY", adapter: "alpaca", assetClass: "equity", env });
    const { bars } = await collect(alpacaAdapter.fetchBars(ctx, { sinceMs, untilMs }));

    assertWatermarkDiscipline(bars, sinceMs, untilMs);
    expect(bars.map((b) => [b.ts, b.close])).toEqual([
      [T0 + MIN, 471],
      [T0 + 2 * MIN, 472],
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("page_token=page2");
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers["APCA-API-KEY-ID"]).toBe("id-abc");
      expect(headers["APCA-API-SECRET-KEY"]).toBe("sec-xyz");
      expect(call.url).not.toContain("id-abc");
      expect(call.url).not.toContain("sec-xyz");
    }
  });

  it("declares its env requirements so sync checks them before fetching", () => {
    expect(alpacaAdapter.requiresEnv).toEqual(["ALPACA_KEY_ID", "ALPACA_SECRET_KEY"]);
  });
});
