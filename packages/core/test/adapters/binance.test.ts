/*
  Binance adapter: archive CSV parsing (ms and µs vintages, headered and
  headerless), in-memory unzip, REST kline parsing, and the full
  monthly → daily → REST fetch walk — all against fixtures built in-test.
  No network.
*/
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  binanceAdapter,
  binanceDailyUrl,
  binanceMonthlyUrl,
  binanceRestUrl,
  parseBinanceKlineCsv,
  parseBinanceRestKlines,
  unzipBinanceKlines,
} from "../../src/adapters/binance";
import {
  assertWatermarkDiscipline,
  bytesResponse,
  collect,
  jsonResponse,
  makeCtx,
  stubFetch,
  textResponse,
} from "./helpers";

const MIN = 60_000;

function klineCsv(rows: [number, number, number, number, number, number][]): string {
  // openTime, open, high, low, close, volume, closeTime, quoteVol, trades, takerBase, takerQuote, ignore
  return rows
    .map(([ts, o, h, l, c, v]) => `${ts},${o},${h},${l},${c},${v},${ts + MIN - 1},0,0,0,0,0`)
    .join("\n");
}

function zipOf(name: string, csv: string): Uint8Array {
  return zipSync({ [name]: strToU8(csv) });
}

describe("archive CSV parsing", () => {
  it("maps the documented columns to exact BarRows (millisecond vintage)", () => {
    const t = Date.UTC(2024, 0, 2, 0, 0);
    const csv = klineCsv([
      [t, 42000.1, 42050.2, 41990.3, 42010.4, 12.345],
      [t + MIN, 42010.4, 42020, 42000, 42015.5, 3.21],
    ]);
    expect(parseBinanceKlineCsv(csv, "BTCUSDT", "1m")).toEqual([
      {
        symbol: "BTCUSDT",
        tf: "1m",
        ts: t,
        open: 42000.1,
        high: 42050.2,
        low: 41990.3,
        close: 42010.4,
        volume: 12.345,
        contract: null,
      },
      {
        symbol: "BTCUSDT",
        tf: "1m",
        ts: t + MIN,
        open: 42010.4,
        high: 42020,
        low: 42000,
        close: 42015.5,
        volume: 3.21,
        contract: null,
      },
    ]);
  });

  it("normalizes the newer MICROsecond vintage and skips its header row", () => {
    const t = Date.UTC(2025, 0, 2, 0, 0);
    const csv =
      "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n" +
      klineCsv([[t * 1000, 95000, 95100, 94900, 95050, 1.5]]);
    const bars = parseBinanceKlineCsv(csv, "BTCUSDT", "1m");
    expect(bars).toHaveLength(1);
    expect(bars[0]?.ts).toBe(t); // µs → ms
    expect(bars[0]?.close).toBe(95050);
  });

  it("fails loudly when the column layout drifts", () => {
    expect(() => parseBinanceKlineCsv("123456789,1.0", "BTCUSDT", "1m")).toThrow(/drifted/);
  });

  it("unzips the single-CSV archive in memory", () => {
    const t = Date.UTC(2024, 0, 2);
    const csv = klineCsv([[t, 1, 2, 0.5, 1.5, 9]]);
    const text = unzipBinanceKlines(zipOf("BTCUSDT-1m-2024-01.csv", csv));
    expect(parseBinanceKlineCsv(text, "BTCUSDT", "1m")[0]?.ts).toBe(t);
    expect(() => unzipBinanceKlines(zipSync({ "readme.txt": strToU8("hi") }))).toThrow(/no CSV/);
  });
});

describe("REST kline parsing", () => {
  it("maps [openTime, open, high, low, close, volume, …] arrays", () => {
    const t = Date.UTC(2024, 1, 1, 10, 0);
    const payload = [
      [t, "42000.1", "42050.2", "41990.3", "42010.4", "12.345", t + MIN - 1, "0", 0, "0", "0", "0"],
    ];
    expect(parseBinanceRestKlines(payload, "BTCUSDT", "1m")).toEqual([
      {
        symbol: "BTCUSDT",
        tf: "1m",
        ts: t,
        open: 42000.1,
        high: 42050.2,
        low: 41990.3,
        close: 42010.4,
        volume: 12.345,
        contract: null,
      },
    ]);
  });

  it("rejects a non-array payload (error responses must not become bars)", () => {
    expect(() =>
      parseBinanceRestKlines({ code: -1121, msg: "Invalid symbol." }, "X", "1m"),
    ).toThrow(/drifted/);
  });
});

describe("URL builders (pinned so vendor drift is a visible diff)", () => {
  it("builds archive and REST URLs exactly", () => {
    expect(binanceMonthlyUrl("spot", "BTCUSDT", 2024, 3)).toBe(
      "https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2024-03.zip",
    );
    expect(binanceDailyUrl("spot", "BTCUSDT", "2024-03-05")).toBe(
      "https://data.binance.vision/data/spot/daily/klines/BTCUSDT/1m/BTCUSDT-1m-2024-03-05.zip",
    );
    expect(binanceRestUrl("BTCUSDT", 1700000000000)).toBe(
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=1700000000000&limit=1000",
    );
  });
});

describe("fetchBars walks monthly → daily → REST with watermark discipline", () => {
  afterEach(() => vi.unstubAllGlobals());

  const jan31 = (h: number, m: number) => Date.UTC(2024, 0, 31, h, m);
  const feb1 = (h: number, m: number) => Date.UTC(2024, 1, 1, h, m);
  const feb2 = (h: number, m: number) => Date.UTC(2024, 1, 2, h, m);

  it("yields only (since, until], ascending, and stitches the three sources", async () => {
    const sinceMs = jan31(23, 58);
    const untilMs = feb2(0, 2);
    const monthlyZip = zipOf(
      "BTCUSDT-1m-2024-01.csv",
      klineCsv([
        [jan31(23, 57), 1, 2, 0.5, 1.5, 10],
        [jan31(23, 58), 1, 2, 0.5, 1.5, 10], // == since → excluded
        [jan31(23, 59), 1, 2, 0.5, 1.5, 10],
      ]),
    );
    const dailyZip = zipOf(
      "BTCUSDT-1m-2024-02-01.csv",
      klineCsv([
        [feb1(0, 0), 1, 2, 0.5, 1.5, 10],
        [feb1(0, 1), 1, 2, 0.5, 1.5, 10],
      ]),
    );
    const restPage = [feb2(0, 0), feb2(0, 1), feb2(0, 2), feb2(0, 3)].map((t) => [
      t,
      "1",
      "2",
      "0.5",
      "1.5",
      "10",
      t + MIN - 1,
    ]);

    const { calls } = stubFetch((url) => {
      if (url.includes("BTCUSDT-1m-2024-01.zip")) return bytesResponse(monthlyZip);
      if (url.includes("BTCUSDT-1m-2024-02.zip")) return textResponse("", 404);
      if (url.includes("BTCUSDT-1m-2024-02-01.zip")) return bytesResponse(dailyZip);
      if (url.includes("BTCUSDT-1m-2024-02-02.zip")) return textResponse("", 404);
      if (url.startsWith("https://api.binance.com/api/v3/klines")) return jsonResponse(restPage);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const ctx = makeCtx({ symbol: "BTCUSDT", adapter: "binance" });
    const { bars } = await collect(binanceAdapter.fetchBars(ctx, { sinceMs, untilMs }));

    assertWatermarkDiscipline(bars, sinceMs, untilMs);
    expect(bars.map((b) => b.ts)).toEqual([
      jan31(23, 59),
      feb1(0, 0),
      feb1(0, 1),
      feb2(0, 0),
      feb2(0, 1),
      feb2(0, 2), // feb2 00:03 is beyond until → clamped
    ]);
    // Daily archive covered all of Feb 1, so REST resumes at Feb 2 00:00 sharp.
    const restCall = calls.find((c) => c.url.startsWith("https://api.binance.com"));
    expect(restCall?.url).toContain(`startTime=${feb2(0, 0)}`);
  });

  it("discovers history's start via REST when there is no watermark", async () => {
    const untilMs = feb1(0, 5);
    const dailyZip = zipOf(
      "BTCUSDT-1m-2024-02-01.csv",
      klineCsv([
        [feb1(0, 0), 1, 2, 0.5, 1.5, 10],
        [feb1(0, 1), 1, 2, 0.5, 1.5, 10],
      ]),
    );
    const { calls } = stubFetch((url) => {
      if (url.includes("startTime=0&limit=1")) {
        return jsonResponse([[feb1(0, 0), "1", "2", "0.5", "1.5", "10", feb1(0, 0) + MIN - 1]]);
      }
      if (url.includes("BTCUSDT-1m-2024-02.zip")) return textResponse("", 404);
      if (url.includes("BTCUSDT-1m-2024-02-01.zip")) return bytesResponse(dailyZip);
      if (url.startsWith("https://api.binance.com/api/v3/klines")) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const ctx = makeCtx({ symbol: "BTCUSDT", adapter: "binance" });
    const { bars } = await collect(binanceAdapter.fetchBars(ctx, { sinceMs: null, untilMs }));
    expect(calls[0]?.url).toContain("startTime=0&limit=1");
    expect(bars.map((b) => b.ts)).toEqual([feb1(0, 0), feb1(0, 1)]);
    assertWatermarkDiscipline(bars, null, untilMs);
  });

  it("refuses a non-1m timeframe with a config hint", async () => {
    const ctx = makeCtx({ symbol: "BTCUSDT", adapter: "binance", tf: "5m" });
    await expect(
      collect(binanceAdapter.fetchBars(ctx, { sinceMs: null, untilMs: Date.UTC(2024, 0, 2) })),
    ).rejects.toThrow(/"tf": "1m"/);
  });

  it("start + archiveOnly never touch api.binance.com (regions where it answers 451)", async () => {
    const untilMs = feb2(0, 2);
    const dailyZip = zipOf(
      "BTCUSDT-1m-2024-02-01.csv",
      klineCsv([
        [feb1(0, 0), 1, 2, 0.5, 1.5, 10],
        [feb1(0, 1), 1, 2, 0.5, 1.5, 10],
      ]),
    );
    const { calls } = stubFetch((url) => {
      if (url.startsWith("https://api.binance.com")) {
        throw new Error(`archiveOnly must not call the REST host: ${url}`);
      }
      if (url.includes("BTCUSDT-1m-2024-02.zip")) return textResponse("", 404);
      if (url.includes("BTCUSDT-1m-2024-02-01.zip")) return bytesResponse(dailyZip);
      if (url.includes("BTCUSDT-1m-2024-02-02.zip")) return textResponse("", 404);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const ctx = makeCtx({
      symbol: "BTCUSDT",
      adapter: "binance",
      adapterOptions: { start: "2024-02-01", archiveOnly: true },
    });
    const { bars } = await collect(binanceAdapter.fetchBars(ctx, { sinceMs: null, untilMs }));
    // History starts at the configured date (no REST listing probe) and
    // ends at the newest published daily archive (no REST tail).
    expect(bars.map((b) => b.ts)).toEqual([feb1(0, 0), feb1(0, 1)]);
    expect(calls.every((c) => c.url.startsWith("https://data.binance.vision"))).toBe(true);
    assertWatermarkDiscipline(bars, null, untilMs);
  });
});
