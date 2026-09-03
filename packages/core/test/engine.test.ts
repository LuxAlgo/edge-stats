/*
  End-to-end engine test against the hand-computed golden sessions:
  csv ingest → calendar-resolved sessions → feature derivation → queries.
  Every asserted number below traces to the ledger in
  fixtures/golden-sessions/gen-fixture.mjs.
*/
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Store,
  configSchema,
  exportQuery,
  exportTable,
  getSessionBars,
  getSessions,
  loadPresets,
  runPreset,
  runQuery,
  syncSymbols,
  type EdgeStatsConfig,
} from "../src/index";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixtures = join(repoRoot, "fixtures", "golden-sessions");

let dataDir: string;
let store: Store;
let config: EdgeStatsConfig;

const UNTIL = Date.UTC(2024, 1, 1); // fixed upper bound: determinism

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "edge-stats-engine-"));
  mkdirSync(join(dataDir, "calendar"), { recursive: true });
  mkdirSync(join(dataDir, "events"), { recursive: true });
  copyFileSync(
    join(repoRoot, "data", "holidays", "nyse.json"),
    join(dataDir, "calendar", "nyse.json"),
  );
  copyFileSync(
    join(repoRoot, "data", "holidays", "cme.json"),
    join(dataDir, "calendar", "cme.json"),
  );
  copyFileSync(join(repoRoot, "data", "events", "opex.json"), join(dataDir, "events", "opex.json"));

  config = configSchema.parse({
    dataDir,
    minN: { warn: 5, refuse: 2 },
    symbols: [
      {
        symbol: "FIX_STK",
        adapter: "csv",
        assetClass: "equity",
        tf: "1h",
        orWindows: [60],
        ibWindow: 60,
        adapterOptions: {
          path: join(fixtures, "fix-stk.csv"),
          tsUnit: "ms",
          mapping: {
            ts: "ts",
            open: "open",
            high: "high",
            low: "low",
            close: "close",
            volume: "volume",
          },
        },
      },
      {
        symbol: "FIX_FUT",
        adapter: "csv",
        assetClass: "future",
        defaultSession: "rth",
        tf: "1h",
        orWindows: [60],
        ibWindow: 60,
        adapterOptions: {
          path: join(fixtures, "fix-fut.csv"),
          tsUnit: "ms",
          mapping: {
            ts: "ts",
            open: "open",
            high: "high",
            low: "low",
            close: "close",
            volume: "volume",
            contract: "contract",
          },
        },
      },
    ],
  });
  store = await Store.open(dataDir);
  await syncSymbols(store, config, { untilMs: UNTIL });
}, 120_000);

afterAll(async () => {
  await store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function featureRows(symbol: string): Promise<Map<string, Record<string, unknown>>> {
  const rows = await store.all(`
    SELECT *, CAST(trade_date AS VARCHAR) AS td FROM session_features
    WHERE symbol = '${symbol}' AND session_key = 'rth' ORDER BY trade_date
  `);
  return new Map(rows.map((r) => [String(r.td), r]));
}

describe("golden feature derivation", () => {
  it("derives exactly the calendar sessions (MLK excluded)", async () => {
    const rows = await featureRows("FIX_STK");
    expect(rows.size).toBe(9);
    expect(rows.has("2024-01-15")).toBe(false);
  });

  it("reproduces every hand-computed value", async () => {
    const expected = JSON.parse(
      readFileSync(join(fixtures, "expected-features.json"), "utf8"),
    ) as Record<string, Record<string, Record<string, unknown>>>;
    for (const symbol of ["FIX_STK", "FIX_FUT"] as const) {
      const rows = await featureRows(symbol);
      const expectedSessions = expected[symbol];
      if (!expectedSessions) continue;
      for (const [date, fields] of Object.entries(expectedSessions)) {
        if (date === "_note") continue;
        const row = rows.get(date);
        expect(row, `${symbol} ${date} derived`).toBeDefined();
        for (const [field, want] of Object.entries(fields)) {
          const got = row?.[field];
          const label = `${symbol} ${date} ${field}`;
          if (want === null) {
            expect(got, label).toBeNull();
          } else if (typeof want === "number") {
            expect(got, label).toBeTypeOf("number");
            expect(got as number, label).toBeCloseTo(want, 6);
          } else {
            expect(got, label).toBe(want);
          }
        }
      }
    }
  });
});

describe("query counts against the ledger", () => {
  const q = (dsl: string, extra: Partial<Parameters<typeof runQuery>[2]> = {}) =>
    runQuery(store, config, { dsl, symbol: "FIX_STK", ...extra });

  it("gapFill: 4 of 7 gapped sessions filled", async () => {
    const r = await q("gapFill");
    expect(r.n).toBe(7);
    expect(r.successes).toBe(4);
    expect(r.estimate).toBeCloseTo(0.5714, 4);
    expect(r.ci95).not.toBeNull();
    expect(r.stability?.firstHalf).toMatchObject({ n: 3, k: 2 });
    expect(r.stability?.secondHalf).toMatchObject({ n: 4, k: 2 });
    expect(r.perYear).toEqual([{ year: 2024, n: 7, successes: 4, estimate: expect.any(Number) }]);
    expect(r.distribution).toMatchObject({
      count: 4,
      mean: 60,
      min: 0,
      median: 60,
      p90: 120,
      max: 120,
      unit: "minutes",
    });
    expect(r.disclaimer).toContain("Not predictions");
  });

  it("respects conditions, direction filters, and grouping", async () => {
    expect(await q("gapFill WHERE gapDir = down")).toMatchObject({ n: 4, successes: 2 });
    expect(await q("gapReversal")).toMatchObject({ n: 4, successes: 2 });
    const grouped = await q("gapFill", { groupBy: "gapBucket" });
    const byGroup = new Map(grouped.groups?.map((g) => [g.group, g]));
    expect(byGroup.get("xs")).toMatchObject({ n: 2, successes: 1 });
    expect(byGroup.get("s")).toMatchObject({ n: 1, successes: 1 });
    expect(byGroup.get("m")).toMatchObject({ n: 3, successes: 2 });
    expect(byGroup.get("l")).toMatchObject({ n: 1, successes: 0 });
  });

  it("opening range: breaks, false breaks, target ladder, IB", async () => {
    expect(await q("orbBreak(60m, up)")).toMatchObject({ n: 9, successes: 6 });
    expect(await q("orbBreak(60m)")).toMatchObject({ n: 9, successes: 9 });
    expect(await q("orbFalseBreak(60m)")).toMatchObject({ n: 9, successes: 3 });
    expect(await q("orbTargetHit(60m, 1, up)")).toMatchObject({ n: 6, successes: 4 });
    expect(await q("ibExtension(1)")).toMatchObject({ n: 9, successes: 8 });
  });

  it("gap-and-go and day-after conditioning (the beat-delta registry entries)", async () => {
    // Held gaps: S3 (down, unfilled, closed below open), S6 (up, unfilled,
    // green), S9 (down, unfilled, closed below open) — of 7 gapped sessions.
    expect(await q("gapHold")).toMatchObject({ n: 7, successes: 3 });
    expect(await q("gapHold(down)")).toMatchObject({ n: 4, successes: 2 });
    // prev_inside_day true only on 01-16 (prev 01-12 inside) and 01-18
    // (prev 01-17 inside); both closed green.
    expect(await q("closeGreen WHERE prevInsideDay")).toMatchObject({ n: 2, successes: 2 });
    // Day-after expansion: inside sessions with a next session are 01-12 and
    // 01-17; their next sessions' range_pct are 2.261554 and 1.512195 — both ≥ 1.5.
    expect(await q("hit(nextRangePct, gte, 1.5) WHERE insideDay")).toMatchObject({
      n: 2,
      successes: 2,
    });
  });

  it("prior levels, inside days, streaks, next-session outcomes", async () => {
    expect(await q("touchPrevHigh")).toMatchObject({ n: 8, successes: 4 });
    expect(await q("closeGreen WHERE insideDay")).toMatchObject({ n: 3, successes: 1 });
    expect(await q("nextCloseGreen WHERE insideDay")).toMatchObject({ n: 2, successes: 2 });
    expect(await q("closeGreen")).toMatchObject({ n: 9, successes: 5 });
    expect(await q("hit(retOcPct, gte, 1)")).toMatchObject({ n: 9, successes: 4 });
    expect(await q("closeGreen WHERE fvgPresent(open, below)")).toMatchObject({
      n: 3,
      successes: 1,
    });
  });

  it("event-day conditioning is trading-calendar aware", async () => {
    expect(await q("closeGreen WHERE eventDay('OPEX')")).toMatchObject({ n: 1, successes: 0 });
    expect(await q("closeGreen WHERE dayBeforeEvent('OPEX')")).toMatchObject({
      n: 1,
      successes: 1,
    });
  });

  it("refuses estimates below the floor unless forced, and always keeps counts", async () => {
    const refused = await q("closeGreen WHERE streak(red, 2)");
    expect(refused.n).toBe(1);
    expect(refused.successes).toBe(1);
    expect(refused.guards.refused).toBe(true);
    expect(refused.estimate).toBeNull();
    expect(refused.ci95).toBeNull();
    const forced = await q("closeGreen WHERE streak(red, 2)", { force: true });
    expect(forced.estimate).toBe(1);
    expect(forced.guards.refused).toBe(true);
  });

  it("a roll is not a gap: the futures roll day is excluded from gap stats", async () => {
    const r = await runQuery(store, config, { dsl: "gapFill", symbol: "FIX_FUT" });
    expect(r.n).toBe(2); // Jan 9 + Jan 11; Jan 10 (roll) excluded by construction
    expect(r.successes).toBe(2);
    const rollDays = await runQuery(store, config, {
      dsl: "closeGreen WHERE rollDay",
      symbol: "FIX_FUT",
    });
    expect(rollDays.n).toBe(1);
  });

  it("drill-down returns the exact sessions behind the number", async () => {
    const r = await q("gapFill WHERE gapDir = down");
    expect(r.sessions.map((s) => s.tradeDate).sort()).toEqual([
      "2024-01-10",
      "2024-01-11",
      "2024-01-17",
      "2024-01-19",
    ]);
    const details = await getSessions(
      store,
      r.sessions.map((s) => s.sessionId),
    );
    expect(details).toHaveLength(4);
    expect(details[0]?.features.symbol).toBe("FIX_STK");
  });

  it("session view: one session's bars from its partition, with the derived levels", async () => {
    const r = await q("gapFill WHERE gapDir = down");
    const ref = r.sessions.find((s) => s.tradeDate === "2024-01-11");
    expect(ref).toBeDefined();
    const view = await getSessionBars(store, config, ref!.sessionId);
    const features = (await featureRows("FIX_STK")).get("2024-01-11");
    expect(features).toBeDefined();

    expect(view.sessionId).toBe("FIX_STK|rth|2024-01-11");
    expect(view).toMatchObject({ symbol: "FIX_STK", sessionKey: "rth", tf: "1h" });
    expect(view.tz).toBe("America/New_York");
    expect(view.startTs).toBe(Number(features?.start_ts));
    expect(view.endTs).toBe(Number(features?.end_ts));

    // Hourly RTH: 09:30 … 15:30 is seven bars, all inside [start, end), oldest first.
    expect(view.bars).toHaveLength(7);
    expect(view.bars.every((b) => b.ts >= view.startTs && b.ts < view.endTs)).toBe(true);
    expect(view.bars.map((b) => b.ts)).toEqual([...view.bars.map((b) => b.ts)].sort());
    expect(view.bars[0]?.open).toBeCloseTo(Number(features?.open), 6);
    expect(view.bars[6]?.close).toBeCloseTo(Number(features?.close), 6);

    // Levels are the feature row's own numbers, never recomputed here.
    expect(view.levels.prevClose).toBeCloseTo(Number(features?.prev_close), 6);
    expect(view.levels.prevHigh).toBeCloseTo(Number(features?.prev_high), 6);
    expect(view.levels.prevLow).toBeCloseTo(Number(features?.prev_low), 6);
    expect(view.levels.gapDir).toBe("down");
    expect(view.levels.gapFilled).toBe(features?.gap_filled);
    expect(view.times.gapFillMin).toBe(features?.gap_fill_min ?? null);
    expect(view.levels.openingRanges).toEqual([
      expect.objectContaining({ window: 60, high: features?.or60_high, low: features?.or60_low }),
    ]);

    // Context: the tail of earlier sessions (hourly bars leave no pre-market),
    // strictly before the open, oldest first, capped at the request.
    expect(view.context.kind).toBe("prior-session");
    expect(view.context.bars.length).toBeGreaterThan(0);
    expect(view.context.bars.length).toBeLessThanOrEqual(30);
    expect(view.context.bars.every((b) => b.ts < view.startTs)).toBe(true);
    const small = await getSessionBars(store, config, ref!.sessionId, { contextBars: 3 });
    expect(small.context.bars).toHaveLength(3);
    const none = await getSessionBars(store, config, ref!.sessionId, { contextBars: 0 });
    expect(none.context).toMatchObject({ kind: "none", bars: [] });
    expect(view.disclaimer).toContain("Not predictions");
  });

  it("session view refuses unknown sessions and absurd context requests", async () => {
    await expect(getSessionBars(store, config, "FIX_STK|rth|1999-01-01")).rejects.toThrow(
      /unknown session/,
    );
    const r = await q("gapFill");
    const id = r.sessions[0]!.sessionId;
    await expect(getSessionBars(store, config, id, { contextBars: 999 })).rejects.toThrow(
      /contextBars/,
    );
    await expect(getSessionBars(store, config, id, { contextBars: -1 })).rejects.toThrow(
      /contextBars/,
    );
  });

  it("is deterministic: same store, same query, identical envelope", async () => {
    const a = await q("gapFill WHERE dayOfWeek = Tue");
    const b = await q("gapFill WHERE dayOfWeek = Tue");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("echoes the normalized query so mis-parses are visible", async () => {
    const r = await q("gapFill   WHERE  gapDir=down AND absGapPct >= 0.3");
    expect(r.query.dsl).toBe("gapFill WHERE gapDir = down AND absGapPct >= 0.3");
  });
});

describe("presets and export", () => {
  it("runs the gap-fill preset with params", async () => {
    const presets = loadPresets(join(repoRoot, "presets"));
    const r = await runPreset(store, config, presets, {
      presetId: "gap-fill",
      symbol: "FIX_STK",
      params: { minGapPct: 0.15 },
    });
    expect(r.n).toBe(5);
    expect(r.successes).toBe(3);
    expect(r.preset.id).toBe("gap-fill");
    expect(r.query.dsl).toContain("absGapPct >= 0.15");
  });

  it("rejects unknown presets and params with hints", async () => {
    const presets = loadPresets(join(repoRoot, "presets"));
    await expect(
      runPreset(store, config, presets, { presetId: "gap-fll", symbol: "FIX_STK" }),
    ).rejects.toThrow(/unknown preset/);
    await expect(
      runPreset(store, config, presets, {
        presetId: "gap-fill",
        symbol: "FIX_STK",
        params: { nope: 1 },
      }),
    ).rejects.toThrow(/no param/);
  });

  it("exports query matches and whole tables", async () => {
    const outCsv = join(dataDir, "tmp", "gaps.csv");
    const summary = await exportQuery(
      store,
      config,
      { dsl: "gapFill", symbol: "FIX_STK" },
      outCsv,
      "csv",
    );
    expect(summary.rows).toBe(7);
    expect(existsSync(outCsv)).toBe(true);
    const header = readFileSync(outCsv, "utf8").split("\n")[0] ?? "";
    expect(header).toContain("outcome_success");

    const outParquet = join(dataDir, "tmp", "bars.parquet");
    const bars = await exportTable(store, "bars", outParquet, "parquet");
    expect(bars.rows).toBe(63 + 28);
    expect(existsSync(outParquet)).toBe(true);
  });

  it("sync is idempotent: a second run ingests nothing new", async () => {
    const again = await syncSymbols(store, config, { untilMs: UNTIL });
    expect(again.symbols.every((s) => s.barsInserted === 0)).toBe(true);
  });
});
