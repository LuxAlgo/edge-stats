/*
  Dukascopy adapter: row mapping from dukascopy-node's JSON format, the
  7-day window walk (weekends legitimately empty), instrument defaulting,
  and watermark discipline. The library is injected, so no network and no
  bi5 decoding here.
*/
import { describe, expect, it } from "vitest";
import { makeDukascopyAdapter, parseDukascopyRows } from "../../src/adapters/dukascopy";
import { assertWatermarkDiscipline, collect, makeCtx } from "./helpers";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2024, 2, 4, 0, 0); // Monday 2024-03-04
const minute = (i: number) => T0 + i * MIN;

const row = (i: number) => ({
  timestamp: minute(i),
  open: 1.08 + i / 1e4,
  high: 1.081 + i / 1e4,
  low: 1.079 + i / 1e4,
  close: 1.0805 + i / 1e4,
  volume: 55 + i,
});

describe("row mapping", () => {
  it("maps dukascopy-node JSON rows and sorts ascending", () => {
    const bars = parseDukascopyRows([row(2), row(1)], "EURUSD", "1m");
    expect(bars.map((b) => b.ts)).toEqual([minute(1), minute(2)]);
    expect(bars[0]).toMatchObject({ symbol: "EURUSD", tf: "1m", open: 1.0801, volume: 56 });
  });

  it("defaults missing volume to zero", () => {
    const bars = parseDukascopyRows([{ ...row(1), volume: undefined }], "EURUSD", "1m");
    expect(bars[0]?.volume).toBe(0);
  });

  it("rejects drifted shapes instead of storing them", () => {
    expect(() => parseDukascopyRows({ nope: true }, "EURUSD", "1m")).toThrow(/drifted/);
    expect(() => parseDukascopyRows([42], "EURUSD", "1m")).toThrow(/drifted/);
  });
});

describe("fetch loop", () => {
  it("walks 7-day windows from the watermark, defaulting the instrument to the lowercased symbol", async () => {
    const windows: { instrument: string; from: number; to: number }[] = [];
    const adapter = makeDukascopyAdapter(async ({ instrument, from, to }) => {
      windows.push({ instrument, from: from.getTime(), to: to.getTime() });
      // First window (a quiet week): nothing. Second: two bars.
      return windows.length === 1 ? [] : [row(1), row(2)];
    });
    const ctx = makeCtx({ symbol: "EURUSD", adapter: "dukascopy", assetClass: "forex" });
    const since = T0 - 10 * DAY;
    const until = minute(10);
    const { bars } = await collect(adapter.fetchBars(ctx, { sinceMs: since, untilMs: until }));

    expect(windows).toHaveLength(2);
    expect(windows[0]?.instrument).toBe("eurusd");
    expect(windows[0]?.from).toBe(since + 1);
    expect(windows[0]?.to).toBe(since + 7 * DAY);
    expect(windows[1]?.to).toBe(until);
    expect(bars).toHaveLength(2);
    assertWatermarkDiscipline(bars, since, until);
  });

  it("honors an explicit instrument id and start bound on first sync", async () => {
    const windows: { instrument: string; from: number }[] = [];
    const adapter = makeDukascopyAdapter(async ({ instrument, from }) => {
      windows.push({ instrument, from: from.getTime() });
      return [];
    });
    const ctx = makeCtx({
      symbol: "GER40",
      adapter: "dukascopy",
      assetClass: "forex",
      adapterOptions: { instrument: "deuidxeur", start: "2024-03-01" },
    });
    await collect(adapter.fetchBars(ctx, { sinceMs: null, untilMs: T0 + DAY }));
    expect(windows[0]?.instrument).toBe("deuidxeur");
    expect(windows[0]?.from).toBe(Date.parse("2024-03-01T00:00:00Z"));
  });
});
