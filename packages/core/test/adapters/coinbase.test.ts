/*
  Coinbase adapter: candle parsing (newest-first → ascending, sec → ms,
  the [time, low, high, open, close, volume] column order), pinned URLs,
  and the 300-minute window walk. No network.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coinbaseAdapter,
  coinbaseCandlesUrl,
  parseCoinbaseCandles,
} from "../../src/adapters/coinbase";
import { assertWatermarkDiscipline, collect, jsonResponse, makeCtx, stubFetch } from "./helpers";

const MIN = 60_000;
const T0 = Date.UTC(2024, 2, 1, 0, 0); // 2024-03-01T00:00Z
const minute = (i: number) => T0 + i * MIN;
const sec = (ms: number) => ms / 1000;

describe("candle parsing", () => {
  it("reorders newest-first rows ascending and maps [time, low, high, open, close, volume]", () => {
    const payload = [
      [sec(minute(2)), 42010, 42120, 42100, 42020, 7.5], // newest first, as the API sends it
      [sec(minute(1)), 42000, 42100, 42050, 42090, 12.5],
    ];
    expect(parseCoinbaseCandles(payload, "BTC-USD", "1m")).toEqual([
      {
        symbol: "BTC-USD",
        tf: "1m",
        ts: minute(1),
        open: 42050,
        high: 42100,
        low: 42000,
        close: 42090,
        volume: 12.5,
        contract: null,
      },
      {
        symbol: "BTC-USD",
        tf: "1m",
        ts: minute(2),
        open: 42100,
        high: 42120,
        low: 42010,
        close: 42020,
        volume: 7.5,
        contract: null,
      },
    ]);
  });

  it("rejects drifted shapes instead of storing them", () => {
    expect(() => parseCoinbaseCandles({ message: "NotFound" }, "BTC-USD", "1m")).toThrow(/drifted/);
    expect(() => parseCoinbaseCandles([[1, 2, 3]], "BTC-USD", "1m")).toThrow(/drifted/);
  });
});

describe("URL builder (pinned)", () => {
  it("asks for granularity 60 with ISO bounds", () => {
    expect(coinbaseCandlesUrl("BTC-USD", Date.UTC(2024, 2, 1), Date.UTC(2024, 2, 1, 5))).toBe(
      "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2024-03-01T00%3A00%3A00.000Z&end=2024-03-01T05%3A00%3A00.000Z",
    );
  });
});

describe("fetchBars walks 300-minute windows forward from the watermark", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("paginates, dedupes the window boundary, and respects (since, until]", async () => {
    const sinceMs = minute(0);
    const untilMs = minute(400);
    const { calls } = stubFetch((url) => {
      const start = Date.parse(new URL(url).searchParams.get("start") ?? "");
      if (start <= minute(1)) {
        // window 1 — newest-first, sparse
        return jsonResponse([
          [sec(minute(300)), 1, 2, 1.5, 1.8, 3],
          [sec(minute(2)), 1, 2, 1.5, 1.8, 2],
          [sec(minute(1)), 1, 2, 1.5, 1.8, 1],
        ]);
      }
      // window 2 — repeats the boundary candle (inclusive bounds server-side)
      return jsonResponse([
        [sec(minute(400)), 1, 2, 1.5, 1.8, 5],
        [sec(minute(301)), 1, 2, 1.5, 1.8, 4],
        [sec(minute(300)), 1, 2, 1.5, 1.8, 3],
      ]);
    });

    const ctx = makeCtx({ symbol: "BTC-USD", adapter: "coinbase" });
    const { bars } = await collect(coinbaseAdapter.fetchBars(ctx, { sinceMs, untilMs }));

    assertWatermarkDiscipline(bars, sinceMs, untilMs);
    expect(bars.map((b) => b.ts)).toEqual([
      minute(1),
      minute(2),
      minute(300),
      minute(301),
      minute(400),
    ]);
    expect(calls).toHaveLength(2);
  });

  it("advances past empty windows (thin markets, pre-listing) without stalling", async () => {
    const sinceMs = minute(0);
    const untilMs = minute(600);
    const { calls } = stubFetch((url) => {
      const start = Date.parse(new URL(url).searchParams.get("start") ?? "");
      if (start <= minute(1)) return jsonResponse([]);
      return jsonResponse([[sec(minute(400)), 1, 2, 1.5, 1.8, 9]]);
    });
    const ctx = makeCtx({ symbol: "BTC-USD", adapter: "coinbase" });
    const { bars } = await collect(coinbaseAdapter.fetchBars(ctx, { sinceMs, untilMs }));
    expect(bars.map((b) => b.ts)).toEqual([minute(400)]);
    expect(calls).toHaveLength(2);
  });
});
