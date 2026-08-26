/*
  Massive adapter: flat-file parsing (nanosecond window_start, whole-market
  ticker filtering, header aliases), gzip inflation, chronological
  multi-file import with watermark discipline, and the deliberately
  unimplemented REST path that must refuse with guidance — never guess a
  URL, never echo a key.
*/
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, strToU8 } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import {
  inflateMassiveFile,
  massiveAdapter,
  parseMassiveFlatCsv,
} from "../../src/adapters/massive";
import { assertWatermarkDiscipline, collect, makeCtx } from "./helpers";

const MIN = 60_000;
const T0 = Date.UTC(2024, 0, 2, 14, 30);
const ns = (ms: number) => `${ms}000000`;

const HEADER = "ticker,volume,open,close,high,low,window_start,transactions";
const row = (ticker: string, tsMs: number, close: number) =>
  `${ticker},1200,470.1,${close},470.6,469.9,${ns(tsMs)},35`;

const tmpRoot = mkdtempSync(join(tmpdir(), "edge-stats-massive-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("flat-file parsing", () => {
  it("normalizes nanosecond window_start to ms and keeps only the configured ticker", () => {
    const csv = [
      HEADER,
      row("SPY", T0, 470.5),
      row("QQQ", T0, 400.0),
      row("SPY", T0 + MIN, 470.9),
    ].join("\n");
    expect(parseMassiveFlatCsv(csv, "SPY", "1m")).toEqual([
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
      {
        symbol: "SPY",
        tf: "1m",
        ts: T0 + MIN,
        open: 470.1,
        high: 470.6,
        low: 469.9,
        close: 470.9,
        volume: 1200,
        contract: null,
      },
    ]);
  });

  it("accepts single-symbol exports without a ticker column and alias headers", () => {
    const csv = `timestamp,open,high,low,close,volume\n${T0},1,2,0.5,1.5,10`;
    const bars = parseMassiveFlatCsv(csv, "SPY", "1m");
    expect(bars).toHaveLength(1);
    expect(bars[0]?.ts).toBe(T0); // ms stays ms — units detected by magnitude
  });

  it("fails loudly when required columns are missing", () => {
    expect(() => parseMassiveFlatCsv("a,b,c\n1,2,3", "SPY", "1m")).toThrow(
      /missing expected columns/,
    );
  });

  it("inflates .csv.gz bytes and passes plain CSV through", () => {
    const csv = [HEADER, row("SPY", T0, 470.5)].join("\n");
    expect(inflateMassiveFile(gzipSync(strToU8(csv)))).toBe(csv);
    expect(inflateMassiveFile(strToU8(csv))).toBe(csv);
  });
});

describe("fetchBars imports flat files in name order with watermark discipline", () => {
  it("walks a directory of .csv and .csv.gz files, filtering (since, until]", async () => {
    const dir = join(tmpRoot, "flat");
    mkdirSync(dir, { recursive: true });
    const day2 = T0 + 24 * 60 * MIN;
    writeFileSync(
      join(dir, "2024-01-02.csv"),
      [HEADER, row("SPY", T0, 470.5), row("SPY", T0 + MIN, 470.9), row("QQQ", T0, 400)].join("\n"),
    );
    writeFileSync(
      join(dir, "2024-01-03.csv.gz"),
      gzipSync(
        strToU8([HEADER, row("SPY", day2, 471.2), row("SPY", day2 + MIN, 471.6)].join("\n")),
      ),
    );

    const sinceMs = T0; // watermark sits on the first bar → it must not re-import
    const untilMs = day2;
    const ctx = makeCtx({
      symbol: "SPY",
      adapter: "massive",
      assetClass: "equity",
      adapterOptions: { files: dir },
    });
    const { bars } = await collect(massiveAdapter.fetchBars(ctx, { sinceMs, untilMs }));

    assertWatermarkDiscipline(bars, sinceMs, untilMs);
    expect(bars.map((b) => [b.ts, b.close])).toEqual([
      [T0 + MIN, 470.9],
      [day2, 471.2], // day2 + MIN is beyond until → clamped
    ]);
    expect(bars.every((b) => b.symbol === "SPY")).toBe(true);
  });

  it("points at a helpful error when the path does not exist", async () => {
    const ctx = makeCtx({
      symbol: "SPY",
      adapter: "massive",
      assetClass: "equity",
      adapterOptions: { files: join(tmpRoot, "nope") },
    });
    await expect(
      collect(massiveAdapter.fetchBars(ctx, { sinceMs: null, untilMs: T0 })),
    ).rejects.toThrow(/no such file or directory/);
  });
});

describe("the REST path is a documented TODO, not a guess", () => {
  it("without files or key: says exactly what to configure", async () => {
    const ctx = makeCtx({ symbol: "SPY", adapter: "massive", assetClass: "equity" });
    await expect(
      collect(massiveAdapter.fetchBars(ctx, { sinceMs: null, untilMs: T0 })),
    ).rejects.toThrow(/adapterOptions\.files.*MASSIVE_API_KEY/s);
  });

  it("with a key but no files: refuses with guidance and never echoes the key value", async () => {
    const ctx = makeCtx({
      symbol: "SPY",
      adapter: "massive",
      assetClass: "equity",
      env: { MASSIVE_API_KEY: "sk-massive-secret" },
    });
    try {
      await collect(massiveAdapter.fetchBars(ctx, { sinceMs: null, untilMs: T0 }));
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/not implemented yet/);
      expect(msg).toContain("MASSIVE_API_KEY");
      expect(msg).toContain("flat files");
      expect(msg).not.toContain("sk-massive-secret");
    }
  });

  it("stays keyless for the flat-file path (requiresEnv is empty)", () => {
    expect(massiveAdapter.requiresEnv).toEqual([]);
  });
});
