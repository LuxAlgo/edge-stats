/*
  Hyperliquid adapter: candle-object parsing (string numerics), pinned
  request body, the 5000-minute window walk with empty windows advanced
  (retention, not pending data), and the tail-source first-sync bound. No
  network.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hyperliquidAdapter,
  hyperliquidCandleBody,
  parseHyperliquidCandles,
} from "../../src/adapters/hyperliquid";
import { assertWatermarkDiscipline, collect, jsonResponse, makeCtx, stubFetch } from "./helpers";

const MIN = 60_000;
const T0 = Date.UTC(2024, 2, 1, 0, 0);
const minute = (i: number) => T0 + i * MIN;

afterEach(() => {
  vi.unstubAllGlobals();
});

const candle = (i: number) => ({
  t: minute(i),
  T: minute(i + 1),
  s: "BTC",
  i: "1m",
  o: String(42000 + i),
  h: String(42010 + i),
  l: String(41990 + i),
  c: String(42005 + i),
  v: String(3.5 + i),
  n: 12,
});

describe("candle parsing", () => {
  it("maps {t,o,h,l,c,v} objects with string numerics and sorts ascending", () => {
    const bars = parseHyperliquidCandles([candle(2), candle(1)], "BTC", "1m");
    expect(bars.map((b) => b.ts)).toEqual([minute(1), minute(2)]);
    expect(bars[0]).toMatchObject({
      symbol: "BTC",
      tf: "1m",
      open: 42001,
      high: 42011,
      low: 41991,
      close: 42006,
      volume: 4.5,
      contract: null,
    });
  });

  it("rejects drifted shapes instead of storing them", () => {
    expect(() => parseHyperliquidCandles({ error: "x" }, "BTC", "1m")).toThrow(/drifted/);
    expect(() => parseHyperliquidCandles([[1, 2]], "BTC", "1m")).toThrow(/drifted/);
    expect(() => parseHyperliquidCandles([{ o: "1" }], "BTC", "1m")).toThrow(/unparseable/);
  });
});

describe("request body (pinned)", () => {
  it("asks for a 1m candleSnapshot of the exact window", () => {
    expect(hyperliquidCandleBody("BTC", 1000, 2000)).toBe(
      '{"type":"candleSnapshot","req":{"coin":"BTC","interval":"1m","startTime":1000,"endTime":2000}}',
    );
  });
});

describe("fetch loop", () => {
  it("walks 5000-minute windows, advancing past empty ones (retention, not pending)", async () => {
    let call = 0;
    const { calls } = stubFetch(() => {
      call += 1;
      // First window: venue has nothing that old. Second: two candles.
      return jsonResponse(call === 1 ? [] : [candle(5001), candle(5002)]);
    });
    const ctx = makeCtx({ symbol: "BTC", adapter: "hyperliquid" });
    const until = minute(10_000);
    const { bars } = await collect(
      hyperliquidAdapter.fetchBars(ctx, { sinceMs: minute(0), untilMs: until }),
    );

    expect(calls).toHaveLength(2);
    const bodyOne = JSON.parse(String(calls[0]?.init?.body)) as {
      req: { coin: string; startTime: number; endTime: number };
    };
    expect(bodyOne.req.coin).toBe("BTC");
    expect(bodyOne.req.endTime - bodyOne.req.startTime).toBe(5000 * MIN - 1);
    expect(bars).toHaveLength(2);
    assertWatermarkDiscipline(bars, minute(0), until);
  });

  it("bounds a first sync to the venue's ~5000-candle retention window", async () => {
    const { calls } = stubFetch(() => jsonResponse([]));
    const ctx = makeCtx({ symbol: "BTC", adapter: "hyperliquid", adapterOptions: { coin: "BTC" } });
    const until = minute(20_000);
    await collect(hyperliquidAdapter.fetchBars(ctx, { sinceMs: null, untilMs: until }));
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as { req: { startTime: number } };
    expect(body.req.startTime).toBe(until - 5000 * MIN + 1);
  });
});
