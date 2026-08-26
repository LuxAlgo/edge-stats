/*
  The preset catalog against the hand-computed golden sessions: every file
  must parse, compose, and run, and a spread of presets must reproduce
  counts derived BY HAND from fixtures/golden-sessions/expected-features.json
  (and, where noted, from the bar ledger in gen-fixture.mjs). If the engine
  and a comment below disagree, re-derive by hand before touching either.
*/
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Store,
  configSchema,
  loadPresets,
  runPreset,
  syncSymbols,
  type EdgeStatsConfig,
  type Preset,
  type PresetRunResult,
} from "../../src/index";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const fixtures = join(repoRoot, "fixtures", "golden-sessions");
const presetsDir = join(repoRoot, "presets");

let dataDir: string;
let store: Store;
let config: EdgeStatsConfig;
let presets: Preset[];

const UNTIL = Date.UTC(2024, 1, 1); // fixed upper bound: determinism

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "edge-stats-catalog-"));
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
  presets = loadPresets(presetsDir);
}, 120_000);

afterAll(async () => {
  await store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Every classic report family the catalog promises, by preset id. */
const REQUIRED_IDS = [
  // gaps
  "gap-fill",
  "gap-fill-by-weekday",
  "gap-fill-by-size",
  "gap-fill-by-direction",
  "gap-and-go",
  "gap-reversal",
  "gap-fill-time",
  // opening range
  "orb",
  "orb-by-direction",
  "orb-false-break",
  "orb-target",
  "orb-time-to-break",
  // initial balance
  "initial-balance",
  "ib-extension",
  // prior levels
  "prev-range",
  "prev-high-break-hold",
  "prev-low-break-hold",
  "prev-high-touch-by-open",
  "prev-low-touch",
  // session shape
  "inside-day",
  "outside-day",
  "nr7-expansion",
  "doji-follow-through",
  "engulfing-bull",
  "engulfing-bear",
  // streaks & seasonality
  "streak-reversion",
  "streak-continuation",
  "day-of-week",
  "month-of-year",
  "green-rate",
  // events
  "event-day-fomc",
  "event-day-cpi",
  "event-day-nfp",
  "event-day-opex",
  "day-before-event",
  "day-after-event",
  // time of day
  "high-time",
  "low-time",
  // volatility
  "range-vs-atr",
  "quiet-then-wild",
  // fvg
  "fvg-magnet",
  "fvg-below-green",
];

const CATEGORIES = new Set([
  "gaps",
  "opening-range",
  "initial-balance",
  "levels",
  "session-shape",
  "streaks",
  "seasonality",
  "events",
  "time-of-day",
  "volatility",
  "fvg",
]);

/** The only LuxAlgo Library pages presets may cite — verified to exist. */
const LIBRARY_SLUGS = new Set([
  "concept/gap-fill",
  "concept/gap-and-go",
  "concept/initial-balance",
  "concept/session-high-low-statistics",
  "concept/session-open-close-behaviors",
  "concept/engulfing-bar",
  "concept/candlestick-patterns",
  "indicator/session-gap-fill",
  "indicator/ultimate-opening-range-breakout",
  "indicator/initial-balance-breakout-signals",
  "indicator/session-levels-predictor",
  "indicator/seasonality-widget",
  "indicator/seasonality-chart",
  "indicator/asset-class-seasonality",
  "indicator/session-streaks",
  "indicator/fvg-sessions",
]);

/**
 * Parameters needed to run a preset on the fixture store. The fixture uses
 * hourly bars, so only the 60-minute opening-range window is derived —
 * presets defaulting to 15m get window=60 here. Event-parameterized presets
 * get OPEX, the one calendar that ships with the engine.
 */
function fixtureParams(preset: Preset): Record<string, number | string> {
  const params: Record<string, number | string> = {};
  for (const spec of preset.params) {
    if (spec.name === "window") params.window = 60;
    if (spec.name === "event") params.event = "OPEX";
  }
  return params;
}

const run = (presetId: string, params: Record<string, number | string> = {}) =>
  runPreset(store, config, presets, { presetId, symbol: "FIX_STK", params });

describe("the preset catalog is complete and well-formed", () => {
  it("every preset file parses, ids are unique and match their filenames", () => {
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
    const files = readdirSync(presetsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(files).toEqual(presets.map((p) => p.id).sort());
  });

  it("every classic session-statistics family ships as a preset", () => {
    const ids = new Set(presets.map((p) => p.id));
    for (const required of REQUIRED_IDS) {
      expect(ids.has(required), `missing preset '${required}'`).toBe(true);
    }
  });

  it("every preset documents itself: category, definition prose, honest deltas", () => {
    for (const p of presets) {
      expect(CATEGORIES.has(p.category), `${p.id}: unknown category '${p.category}'`).toBe(true);
      expect(p.summary.length, `${p.id}: summary too thin to define the statistic`).toBeGreaterThan(
        80,
      );
      expect(p.deltas.length, `${p.id}: deltas`).toBeGreaterThanOrEqual(2);
      expect(p.deltas.length, `${p.id}: deltas`).toBeLessThanOrEqual(4);
      expect(p.version).toBeGreaterThanOrEqual(1);
    }
  });

  it("presets only cite Library pages that actually exist", () => {
    for (const p of presets) {
      for (const ref of p.library) {
        const key = `${ref.kind}/${ref.slug}`;
        expect(LIBRARY_SLUGS.has(key), `${p.id} cites unknown library page '${key}'`).toBe(true);
      }
    }
  });
});

describe("every preset runs against the golden fixture", () => {
  it("composes to valid DSL and returns an honest envelope (no preset throws)", async () => {
    for (const preset of presets) {
      const r = await run(preset.id, fixtureParams(preset));
      expect(r.query.dsl.length, `${preset.id}: normalized DSL`).toBeGreaterThan(0);
      expect(r.n, `${preset.id}: n`).toBeGreaterThanOrEqual(0);
      expect(r.successes, `${preset.id}: successes <= n`).toBeLessThanOrEqual(r.n);
      if (r.estimate !== null) {
        expect(r.estimate, `${preset.id}: estimate lower bound`).toBeGreaterThanOrEqual(0);
        expect(r.estimate, `${preset.id}: estimate upper bound`).toBeLessThanOrEqual(1);
      }
      expect(r.disclaimer, `${preset.id}: disclaimer`).toContain("Not predictions");
    }
  }, 120_000);
});

function groupMap(r: PresetRunResult) {
  return new Map((r.groups ?? []).map((g) => [g.group, g]));
}

describe("hand-computed goldens from the fixture ledger", () => {
  /*
    FIX_STK derives 9 RTH sessions (Jan 8–19, 2024; MLK Jan 15 is a holiday).
    Per-session facts below are quoted from expected-features.json.
  */

  it("gap-fill with a 0.15% floor: 3 of 5 qualifying gaps filled", async () => {
    // Gapped sessions and abs_gap_pct: 01-09 0.394, 01-10 0.495, 01-11 0.202,
    // 01-16 1.043, 01-17 0.483, 01-18 0.098, 01-19 0.096. Floor 0.15 keeps the
    // first five. gap_filled: 01-09 T, 01-10 F, 01-11 T, 01-16 F, 01-17 T → 3/5.
    const r = await run("gap-fill", { minGapPct: 0.15 });
    expect(r).toMatchObject({ n: 5, successes: 3 });
    expect(r.estimate).toBeCloseTo(0.6, 6);
    expect(r.query.dsl).toContain("absGapPct >= 0.15");
  });

  it("gap-fill-by-size: xs 1/2, s 1/1, m 2/3, l 0/1 — the hand-counted buckets", async () => {
    // Buckets from expected-features: xs = 01-18 (filled), 01-19 (not);
    // s = 01-11 (filled); m = 01-09 (filled), 01-10 (not), 01-17 (filled);
    // l = 01-16 (not). No xl gap exists in the ledger.
    const r = await run("gap-fill-by-size");
    expect(r).toMatchObject({ n: 7, successes: 4 });
    const g = groupMap(r);
    expect(g.get("xs")).toMatchObject({ n: 2, successes: 1 });
    expect(g.get("s")).toMatchObject({ n: 1, successes: 1 });
    expect(g.get("m")).toMatchObject({ n: 3, successes: 2 });
    expect(g.get("l")).toMatchObject({ n: 1, successes: 0 });
    expect(g.has("xl")).toBe(false);
  });

  it("gap-fill-by-direction: up-gaps filled 2 of 3, down-gaps 2 of 4", async () => {
    // Up gaps: 01-09 (filled), 01-16 (not), 01-18 (filled) → 2/3.
    // Down gaps: 01-10 (not), 01-11 (filled), 01-17 (filled), 01-19 (not) → 2/4.
    // 'none' never appears: gapFill's denominator is gapped sessions only.
    const r = await run("gap-fill-by-direction");
    const g = groupMap(r);
    expect(g.get("up")).toMatchObject({ n: 3, successes: 2 });
    expect(g.get("down")).toMatchObject({ n: 4, successes: 2 });
    expect(r.groups).toHaveLength(2);
  });

  it("gap-reversal: 2 of the 4 filled gaps closed against the gap", async () => {
    // gap_filled sessions: 01-09, 01-11, 01-17, 01-18.
    // gap_reversed: 01-09 T, 01-11 T, 01-17 F, 01-18 F → 2/4.
    const r = await run("gap-reversal");
    expect(r).toMatchObject({ n: 4, successes: 2 });
  });

  it("inside-day: both inside sessions with a next session were followed by a green close", async () => {
    // inside_day true: 01-12, 01-17, 01-19. 01-19 has next_green = null (last
    // session) and drops out of the denominator. next_green: 01-12 T, 01-17 T → 2/2.
    const r = await run("inside-day");
    expect(r).toMatchObject({ n: 2, successes: 2 });
    expect(r.estimate).toBe(1);
  });

  it("engulfing-bull: the one bullish engulfing session (2024-01-11) was followed by a green close", async () => {
    // bull_engulf true only on 01-11; its next_green is true → n=1, k=1.
    // n=1 sits below the refuse floor (2): the estimate is withheld, counts stay.
    const r = await run("engulfing-bull");
    expect(r).toMatchObject({ n: 1, successes: 1 });
    expect(r.guards.refused).toBe(true);
    expect(r.estimate).toBeNull();
  });

  it("streak-reversion after 2 red sessions: one qualifying session, and it closed green (estimate withheld at n=1)", async () => {
    // prev_red_streak >= 2 only on 01-11 (01-09 and 01-10 closed red).
    // 01-11 closed green → n=1, k=1; below the refuse floor the rate is withheld.
    const r = await run("streak-reversion", { n: 2 });
    expect(r).toMatchObject({ n: 1, successes: 1 });
    expect(r.guards.refused).toBe(true);
    expect(r.estimate).toBeNull();
    expect(r.query.dsl).toContain("streak(red, 2)");
  });

  it("streak-continuation after 2 green sessions: 1 of 2 extended the streak", async () => {
    // prev_green_streak >= 2: 01-16 (streak 2) and 01-17 (streak 3).
    // green: 01-16 T, 01-17 F → 1/2. n=2 sits AT the refuse floor, so the
    // estimate shows, flagged as a low sample (warn floor 5).
    const r = await run("streak-continuation", { n: 2 });
    expect(r).toMatchObject({ n: 2, successes: 1 });
    expect(r.estimate).toBeCloseTo(0.5, 6);
    expect(r.guards.refused).toBe(false);
    expect(r.guards.lowSample).toBe(true);
  });

  it("day-of-week: the green rate per weekday matches the ledger exactly", async () => {
    // green by date: 01-08 T, 01-09 F, 01-10 F, 01-11 T, 01-12 T, 01-16 T,
    // 01-17 F, 01-18 T, 01-19 F. By weekday:
    //   Mon: 01-08 → 1/1        Tue: 01-09, 01-16 → 1/2
    //   Wed: 01-10, 01-17 → 0/2 Thu: 01-11, 01-18 → 2/2
    //   Fri: 01-12, 01-19 → 1/2
    const r = await run("day-of-week");
    expect(r).toMatchObject({ n: 9, successes: 5 });
    const g = groupMap(r);
    expect(g.get("Mon")).toMatchObject({ n: 1, successes: 1 });
    expect(g.get("Tue")).toMatchObject({ n: 2, successes: 1 });
    expect(g.get("Wed")).toMatchObject({ n: 2, successes: 0 });
    expect(g.get("Thu")).toMatchObject({ n: 2, successes: 2 });
    expect(g.get("Fri")).toMatchObject({ n: 2, successes: 1 });
  });

  it("green-rate: the baseline is 5 green closes in 9 sessions", async () => {
    const r = await run("green-rate");
    expect(r).toMatchObject({ n: 9, successes: 5 });
    expect(r.estimate).toBeCloseTo(5 / 9, 4);
  });

  it("initial-balance: the N column is the break-type distribution and the estimate is the per-type green rate", async () => {
    // ib_break by date: single_up 01-08, 01-11, 01-16, 01-18 (all green → 4/4);
    // single_down 01-10 F, 01-12 T, 01-19 F (→ 1/3); double 01-09 F, 01-17 F (→ 0/2).
    // No session held its whole balance, so there is no 'none' row.
    const r = await run("initial-balance");
    expect(r).toMatchObject({ n: 9, successes: 5 });
    const g = groupMap(r);
    expect(g.get("single_up")).toMatchObject({ n: 4, successes: 4 });
    expect(g.get("single_down")).toMatchObject({ n: 3, successes: 1 });
    expect(g.get("double")).toMatchObject({ n: 2, successes: 0 });
    expect(g.has("none")).toBe(false);
  });

  it("orb-target (60m, r=1, up): 4 of the 6 up-breaking sessions extended a full range", async () => {
    // or60_first_break = up: 01-08, 01-09, 01-11, 01-16, 01-17, 01-18 (n=6).
    // or60_ext_up_r: 1.0 ✓, 0.1667 ✗, 2.5 ✓, 2.2857 ✓, 0.6 ✗, 2.4444 ✓ → k=4.
    const r = await run("orb-target", { window: 60, dir: "up" });
    expect(r).toMatchObject({ n: 6, successes: 4 });
  });

  it("orb-by-direction (60m, up): 6 of 9 first breaks went up, and Friday never did", async () => {
    // or60_first_break: up on 01-08, 01-09, 01-11, 01-16, 01-17, 01-18;
    // down on 01-10, 01-12, 01-19. Both Fridays (01-12, 01-19) broke down first.
    const r = await run("orb-by-direction", { window: 60 });
    expect(r).toMatchObject({ n: 9, successes: 6 });
    expect(groupMap(r).get("Fri")).toMatchObject({ n: 2, successes: 0 });
  });

  it("prev-high-break-hold: 2 of the 4 sessions that touched the prior high closed above it", async () => {
    // touched_prev_high true: 01-09, 01-12, 01-16, 01-18 (01-08 has no prior).
    // closed_above_prev_high: 01-09 F; 01-12 F (bar ledger: close 100.65 vs
    // prior high 100.7 — gen-fixture.mjs, Jan 11 high / Jan 12 last close);
    // 01-16 T; 01-18 T → 2/4.
    const r = await run("prev-high-break-hold");
    expect(r).toMatchObject({ n: 4, successes: 2 });
  });

  it("prev-high-touch-by-open (upper-half opens): 3 of 5 reached the prior high", async () => {
    // open_pos_prev_range >= 0.5: 01-09 (0.958), 01-12 (0.952), 01-16 (2.111),
    // 01-17 (0.696), 01-19 (0.871) → n=5. touched_prev_high: T, T, T, F, F → k=3.
    const r = await run("prev-high-touch-by-open");
    expect(r).toMatchObject({ n: 5, successes: 3 });
  });

  it("prev-low-touch (lower-half opens): 2 of 3 reached the prior low", async () => {
    // open_pos_prev_range <= 0.5: 01-10 (-0.1875), 01-11 (-0.05), 01-18 (0.143).
    // touched_prev_low: 01-10 T, 01-11 T, 01-18 F → 2/3.
    const r = await run("prev-low-touch");
    expect(r).toMatchObject({ n: 3, successes: 2 });
  });

  it("event-day-opex: the one OPEX session (2024-01-19, third Friday) closed red", async () => {
    // opex.json lists 2024-01-19; that session's green = false → 1/0.
    const r = await run("event-day-opex");
    expect(r).toMatchObject({ n: 1, successes: 0 });
  });

  it("day-before-event (OPEX): the session before expiration (2024-01-18) closed green", async () => {
    // The next trading session after 01-18 is 01-19 = OPEX → n=1; 01-18 green → k=1.
    const r = await run("day-before-event", { event: "OPEX" });
    expect(r).toMatchObject({ n: 1, successes: 1 });
    expect(r.query.dsl).toContain("dayBeforeEvent('OPEX')");
  });

  it("high-time (first 60m): 3 of 9 highs printed in the first hour, and the full clock distribution is attached", async () => {
    // high_time_min by date: 300, 60, 0, 360, 0, 360, 120, 360, 0. Strictly
    // before 60: the three 0s (01-10, 01-12, 01-19) → 3/9. Sorted minutes
    // [0,0,0,60,120,300,360,360,360]: min 0, median 120, max 360, count 9.
    const r = await run("high-time");
    expect(r).toMatchObject({ n: 9, successes: 3 });
    expect(r.distribution).toMatchObject({ count: 9, min: 0, median: 120, max: 360 });
  });

  it("range-vs-atr: honest empty denominator while ATR(14) is still warming up", async () => {
    // rangeVsAtr needs 14 prior sessions; the fixture has at most 8, so every
    // session's range_vs_atr is NULL and the eligible set is empty. The engine
    // must say n=0 with no estimate — not fabricate a rate.
    const r = await run("range-vs-atr");
    expect(r).toMatchObject({ n: 0, successes: 0 });
    expect(r.estimate).toBeNull();
    expect(r.guards.refused).toBe(true);
  });

  it("fvg-below-green: 1 of the 3 sessions with an unfilled FVG below the open closed green", async () => {
    // fvg_below true: 01-17 (red), 01-18 (green), 01-19 (red) → 1/3.
    const r = await run("fvg-below-green");
    expect(r).toMatchObject({ n: 3, successes: 1 });
  });
});
