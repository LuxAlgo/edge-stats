/*
  Databento adapter: the pinned request params (get_cost and get_range must
  see the identical range), nanosecond → ms CSV parsing with exact BigInt
  arithmetic, contract mapping for roll detection, and — most importantly —
  the mandatory cost preflight that refuses to spend past the cap. No
  network; costs are mocked.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCostWithinCap,
  databentoAdapter,
  databentoAuthHeader,
  databentoCostUrl,
  databentoParams,
  databentoRangeUrl,
  parseDatabentoCost,
  parseDatabentoOhlcvCsv,
} from "../../src/adapters/databento";
import { assertWatermarkDiscipline, collect, makeCtx, stubFetch, textResponse } from "./helpers";

const MIN = 60_000;
const T0 = Date.UTC(2024, 1, 1, 0, 0); // 2024-02-01T00:00Z
const ns = (ms: number) => `${ms}000000`;

const RANGE = {
  dataset: "GLBX.MDP3",
  symbolRoot: "ES",
  startIso: "2024-02-01T00:00:00.000Z",
  endIso: "2024-02-02T00:00:00.000Z",
};

const CSV_FIXTURE = [
  "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol",
  `${ns(T0)},32,1,12345,4770.25,4771.00,4769.50,4770.75,1250,ESH4`,
  `${ns(T0 + MIN)},32,1,12345,4770.75,4772.25,4770.50,4772.00,980,ESH4`,
  `${ns(T0 + 2 * MIN)},32,1,12346,4772.00,4772.50,4771.25,4771.50,1100,ESM4`,
].join("\n");

describe("request params are pinned — one function, one place to fix drift", () => {
  it("asks for the volume-ranked continuous contract with identical cost/range params", () => {
    expect(databentoParams(RANGE)).toEqual({
      dataset: "GLBX.MDP3",
      symbols: "ES.v.0",
      stype_in: "continuous",
      schema: "ohlcv-1m",
      start: "2024-02-01T00:00:00.000Z",
      end: "2024-02-02T00:00:00.000Z",
    });
  });

  it("cost URL carries only the metered params; range URL adds the encoding knobs", () => {
    const cost = databentoCostUrl(RANGE);
    const range = databentoRangeUrl(RANGE);
    expect(cost).toContain("https://hist.databento.com/v0/metadata.get_cost?");
    expect(cost).toContain("symbols=ES.v.0");
    expect(cost).not.toContain("encoding=");
    expect(range).toContain("https://hist.databento.com/v0/timeseries.get_range?");
    for (const param of [
      "dataset=GLBX.MDP3",
      "symbols=ES.v.0",
      "stype_in=continuous",
      "schema=ohlcv-1m",
      "encoding=csv",
      "pretty_px=true",
      "pretty_ts=false",
      "map_symbols=true",
    ]) {
      expect(range).toContain(param);
    }
  });

  it("builds HTTP Basic auth with the key as username — from the env NAME", () => {
    const h = databentoAuthHeader({ DATABENTO_API_KEY: "db-key" });
    expect(h.Authorization).toBe(`Basic ${Buffer.from("db-key:").toString("base64")}`);
    expect(() => databentoAuthHeader({})).toThrow(/DATABENTO_API_KEY/);
  });
});

describe("ohlcv-1m CSV parsing", () => {
  it("normalizes nanosecond ts_event to ms and maps the raw contract for roll detection", () => {
    const bars = parseDatabentoOhlcvCsv(CSV_FIXTURE, "ES", "1m");
    expect(bars).toEqual([
      {
        symbol: "ES",
        tf: "1m",
        ts: T0,
        open: 4770.25,
        high: 4771.0,
        low: 4769.5,
        close: 4770.75,
        volume: 1250,
        contract: "ESH4",
      },
      {
        symbol: "ES",
        tf: "1m",
        ts: T0 + MIN,
        open: 4770.75,
        high: 4772.25,
        low: 4770.5,
        close: 4772.0,
        volume: 980,
        contract: "ESH4",
      },
      {
        symbol: "ES",
        tf: "1m",
        ts: T0 + 2 * MIN,
        open: 4772.0,
        high: 4772.5,
        low: 4771.25,
        close: 4771.5,
        volume: 1100,
        contract: "ESM4", // the roll shows up in the bar stream, as the engine expects
      },
    ]);
  });

  it("keeps nanosecond math exact where floats round the wrong way", () => {
    const csv = `ts_event,open,high,low,close,volume,symbol\n1706745659999999999,1,2,0.5,1.5,10,ESH4`;
    expect(parseDatabentoOhlcvCsv(csv, "ES", "1m")[0]?.ts).toBe(1706745659999);
  });

  it("fails loudly when expected columns disappear; an empty body is zero bars", () => {
    expect(() => parseDatabentoOhlcvCsv("ts_event,open\n1,2", "ES", "1m")).toThrow(/drifted/);
    expect(parseDatabentoOhlcvCsv("", "ES", "1m")).toEqual([]);
  });
});

describe("the cost preflight guard", () => {
  it("reads a bare-number estimate, tolerates an object wrapper, rejects garbage", () => {
    expect(parseDatabentoCost("0.0421")).toBe(0.0421);
    expect(parseDatabentoCost('{"cost": 1.25}')).toBe(1.25);
    expect(() => parseDatabentoCost("<html>oops</html>")).toThrow(/preflight/);
  });

  it("throws above the cap with the estimate and how to raise it; passes at/below", () => {
    expect(() => assertCostWithinCap(7.31, 5, "ES.v.0 test-range")).toThrow(
      /\$7\.31.*\$5\.00.*maxCostUsd/s,
    );
    expect(() => assertCostWithinCap(5, 5, "x")).not.toThrow();
    expect(() => assertCostWithinCap(0.01, 5, "x")).not.toThrow();
  });
});

describe("fetchBars runs the preflight before any data leaves the vendor", () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = { DATABENTO_API_KEY: "db-key" };

  it("refuses the pull when the mocked estimate exceeds the default $5 cap", async () => {
    const { calls } = stubFetch((url) => {
      if (url.includes("metadata.get_cost")) return textResponse("12.5");
      throw new Error(`get_range must not be called: ${url}`);
    });
    const ctx = makeCtx({ symbol: "ES", adapter: "databento", assetClass: "future", env });
    await expect(
      collect(databentoAdapter.fetchBars(ctx, { sinceMs: T0, untilMs: T0 + 3 * MIN })),
    ).rejects.toThrow(/\$12\.50.*exceeds.*\$5\.00/s);
    expect(calls).toHaveLength(1); // preflight only — no data request happened
  });

  it("pulls when the estimate fits, with Basic auth on both calls and clamped output", async () => {
    const { calls } = stubFetch((url) => {
      if (url.includes("metadata.get_cost")) return textResponse("0.0400");
      if (url.includes("timeseries.get_range")) return textResponse(CSV_FIXTURE);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const sinceMs = T0; // first fixture bar sits exactly on the watermark → excluded
    const untilMs = T0 + 2 * MIN;
    const ctx = makeCtx({ symbol: "ES", adapter: "databento", assetClass: "future", env });
    const { bars } = await collect(databentoAdapter.fetchBars(ctx, { sinceMs, untilMs }));

    assertWatermarkDiscipline(bars, sinceMs, untilMs);
    expect(bars.map((b) => [b.ts, b.contract])).toEqual([
      [T0 + MIN, "ESH4"],
      [T0 + 2 * MIN, "ESM4"],
    ]);
    expect(calls).toHaveLength(2);
    const expectedAuth = `Basic ${Buffer.from("db-key:").toString("base64")}`;
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(expectedAuth);
      expect(call.url).not.toContain("db-key"); // key rides in the header, never the URL
    }
  });

  it("honors a raised cap only when the user set one", async () => {
    stubFetch((url) => {
      if (url.includes("metadata.get_cost")) return textResponse("12.5");
      if (url.includes("timeseries.get_range")) return textResponse(CSV_FIXTURE);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const ctx = makeCtx({
      symbol: "ES",
      adapter: "databento",
      assetClass: "future",
      env,
      adapterOptions: { maxCostUsd: 20 },
    });
    const { bars } = await collect(
      databentoAdapter.fetchBars(ctx, { sinceMs: null, untilMs: T0 + 2 * MIN }),
    );
    expect(bars).toHaveLength(3);
  });

  it("declares its env requirement so sync checks it before fetching", () => {
    expect(databentoAdapter.requiresEnv).toEqual(["DATABENTO_API_KEY"]);
  });
});
