/*
  LSE adapter: row-object parsing across the vault's timestamp spellings,
  pinned URL grammar, key handling (header set, name-only errors), and the
  5000-row page walk. No network.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { lseAdapter, lseCandlesUrl, parseLseCandles } from "../../src/adapters/lse";
import { assertWatermarkDiscipline, collect, jsonResponse, makeCtx, stubFetch } from "./helpers";

const MIN = 60_000;
const T0 = Date.UTC(2024, 2, 1, 0, 0);
const minute = (i: number) => T0 + i * MIN;

afterEach(() => {
  vi.unstubAllGlobals();
});

const row = (i: number, extra: Record<string, unknown> = {}) => ({
  ts: minute(i),
  open: 1.08 + i / 1e4,
  high: 1.081 + i / 1e4,
  low: 1.079 + i / 1e4,
  close: 1.0805 + i / 1e4,
  volume: 120 + i,
  ...extra,
});

describe("candle parsing", () => {
  it("maps row objects and sorts ascending whatever order the vault sent", () => {
    const bars = parseLseCandles([row(2), row(1)], "EURUSD", "1m");
    expect(bars.map((b) => b.ts)).toEqual([minute(1), minute(2)]);
    expect(bars[0]).toMatchObject({ symbol: "EURUSD", tf: "1m", open: 1.0801, volume: 121 });
  });

  it("accepts epoch seconds, epoch millis, ISO strings, and the `timestamp` spelling", () => {
    const variants = [
      { ...row(1), ts: minute(1) / 1000 },
      { ...row(2), ts: undefined, timestamp: minute(2) },
      { ...row(3), ts: new Date(minute(3)).toISOString() },
    ];
    expect(parseLseCandles(variants, "EURUSD", "1m").map((b) => b.ts)).toEqual([
      minute(1),
      minute(2),
      minute(3),
    ]);
  });

  it("defaults missing volume to zero (FX candles carry no consolidated volume)", () => {
    const bars = parseLseCandles([{ ...row(1), volume: undefined }], "EURUSD", "1m");
    expect(bars[0]?.volume).toBe(0);
  });

  it("rejects drifted shapes instead of storing them", () => {
    expect(() => parseLseCandles({ error: "nope" }, "EURUSD", "1m")).toThrow(/drifted/);
    expect(() => parseLseCandles([[1, 2, 3]], "EURUSD", "1m")).toThrow(/drifted/);
    expect(() => parseLseCandles([{ open: 1 }], "EURUSD", "1m")).toThrow(/drifted/);
  });
});

describe("URL builder (pinned)", () => {
  it("asks the vault for ascending 1m pages of 5000", () => {
    expect(
      lseCandlesUrl("EUR/USD", "2024-03-01T00:00:00.000Z", "2024-03-02T00:00:00.000Z", "fx"),
    ).toBe(
      "https://api.londonstrategicedge.com/vault/candles?symbol=EUR%2FUSD&timeframe=1m&order=asc&limit=5000&start=2024-03-01T00%3A00%3A00.000Z&end=2024-03-02T00%3A00%3A00.000Z&dataset=fx",
    );
  });
});

describe("fetch loop", () => {
  it("refuses to start without LSE_API_KEY, naming the env var only", async () => {
    const ctx = makeCtx({ symbol: "EURUSD", adapter: "lse", assetClass: "forex" });
    await expect(
      collect(lseAdapter.fetchBars(ctx, { sinceMs: null, untilMs: minute(10) })),
    ).rejects.toThrow(/LSE_API_KEY/);
  });

  it("sends the key as x-api-key and pages forward until a short page", async () => {
    const pageOne = Array.from({ length: 5000 }, (_, i) => row(i + 1));
    const pageTwo = [row(5001), row(5002)];
    let call = 0;
    const { calls } = stubFetch(() => {
      call += 1;
      return jsonResponse(call === 1 ? pageOne : pageTwo);
    });
    const ctx = makeCtx({
      symbol: "EURUSD",
      adapter: "lse",
      assetClass: "forex",
      adapterOptions: { lseSymbol: "EUR/USD" },
      env: { LSE_API_KEY: "k" },
    });
    const until = minute(6000);
    const { bars } = await collect(
      lseAdapter.fetchBars(ctx, { sinceMs: minute(0), untilMs: until }),
    );

    expect(calls).toHaveLength(2);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    expect(calls[0]?.url).toContain("symbol=EUR%2FUSD");
    // The second page starts just after the last bar of the first.
    expect(calls[1]?.url).toContain(encodeURIComponent(new Date(minute(5000) + 1).toISOString()));
    expect(bars).toHaveLength(5002);
    assertWatermarkDiscipline(bars, minute(0), until);
  });

  it("keeps the store symbol on bars even when the vault symbol differs", async () => {
    stubFetch(() => jsonResponse([row(1)]));
    const ctx = makeCtx({
      symbol: "EURUSD",
      adapter: "lse",
      assetClass: "forex",
      adapterOptions: { lseSymbol: "EUR/USD" },
      env: { LSE_API_KEY: "k" },
    });
    const { bars } = await collect(
      lseAdapter.fetchBars(ctx, { sinceMs: minute(0), untilMs: minute(5) }),
    );
    expect(bars[0]?.symbol).toBe("EURUSD");
  });
});
