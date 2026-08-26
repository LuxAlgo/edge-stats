/*
  Live Board evaluation against the golden-sessions fixture. The historical
  side reuses the hand-computed ledger (gapFill WHERE gapDir = down → n=4);
  the developing side is a hand-written partial session for 2024-01-22 (the
  next trading day after the fixture) that opens 102.4 against the prior
  102.5 close — a down gap, so the watch's conditions hold while the
  session is incomplete.
*/
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Store,
  configSchema,
  evaluatePass,
  emitAlert,
  getLiveConfig,
  listAlerts,
  readLiveState,
  replayAlert,
  runLiveLoop,
  syncSymbols,
  type AlertPayload,
  type EdgeStatsConfig,
  type LiveWatch,
} from "../../src/index";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const fixtures = join(repoRoot, "fixtures", "golden-sessions");

// 2024-01-22 09:30 America/New_York (EST) = 14:30Z; rth ends 21:00Z.
const JAN22_0930 = 1705933800000;
const HOUR = 3_600_000;
// Three hourly bars: the session is far from complete when we evaluate.
// Opens 102.4 vs the fixture's 2024-01-19 close of 102.5 → gap down, unfilled.
const PARTIAL_DAY_CSV = [
  "ts,open,high,low,close,volume",
  `${JAN22_0930},102.4,102.45,102.2,102.3,900`,
  `${JAN22_0930 + HOUR},102.3,102.4,102.1,102.2,800`,
  `${JAN22_0930 + 2 * HOUR},102.2,102.3,102.0,102.1,700`,
].join("\n");

const UNTIL = Date.UTC(2024, 1, 1); // fixed pull bound for the historical sync
const NOW = new Date("2024-01-22T17:30:00.000Z"); // mid-session, after the 3rd bar
const AFTER_CLOSE = new Date("2024-01-22T22:00:00.000Z"); // past the 21:00Z session end

let dataDir: string;
let barsDir: string;
let ndjsonPath: string;
let store: Store;
let config: EdgeStatsConfig;

function withWatches(watches: LiveWatch[]): EdgeStatsConfig {
  return { ...config, live: { enabled: true, intervalSec: 60, watch: watches, sinks: [] } };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "edge-stats-live-"));
  barsDir = join(dataDir, "csv-in");
  ndjsonPath = join(dataDir, "out", "alerts.ndjson"); // parent dir must be created by the sink
  mkdirSync(barsDir, { recursive: true });
  mkdirSync(join(dataDir, "calendar"), { recursive: true });
  mkdirSync(join(dataDir, "events"), { recursive: true });
  mkdirSync(join(dataDir, "presets"), { recursive: true });
  copyFileSync(
    join(repoRoot, "data", "holidays", "nyse.json"),
    join(dataDir, "calendar", "nyse.json"),
  );
  copyFileSync(join(repoRoot, "data", "events", "opex.json"), join(dataDir, "events", "opex.json"));
  copyFileSync(
    join(repoRoot, "presets", "gap-fill.json"),
    join(dataDir, "presets", "gap-fill.json"),
  );
  copyFileSync(join(fixtures, "fix-stk.csv"), join(barsDir, "fix-stk.csv"));

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
          path: barsDir,
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
    ],
    live: {
      enabled: true,
      intervalSec: 60,
      watch: [
        { dsl: "gapFill WHERE gapDir = down", symbol: "FIX_STK", threshold: { min: 0 }, minN: 4 },
      ],
      sinks: [{ type: "ndjson", path: ndjsonPath }],
    },
  });
  store = await Store.open(dataDir);
  await syncSymbols(store, config, { untilMs: UNTIL });
}, 120_000);

afterAll(async () => {
  await store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("getLiveConfig", () => {
  it("an absent live block parses to a disabled default config", () => {
    const bare = configSchema.parse({ dataDir: "x" });
    const live = getLiveConfig(bare);
    expect(live.enabled).toBe(false);
    expect(live.intervalSec).toBe(300);
    expect(live.watch).toEqual([]);
    expect(live.sinks).toEqual([]);
  });
});

describe("evaluatePass against the developing session", () => {
  let firedPayload: AlertPayload;

  it("with no developing session the setup reads resolved and history stops the day before", async () => {
    // No 2024-01-22 bars exist yet: the latest session is 2024-01-19, complete.
    const { setups, alertsFired } = await evaluatePass(store, config, { now: NOW });
    expect(setups).toHaveLength(1);
    expect(setups[0]?.phase).toBe("resolved");
    expect(setups[0]?.tradeDate).toBe("2024-01-19");
    // until 2024-01-18 → gapped-down sessions are Jan 10, 11, 17 only.
    expect(setups[0]?.n).toBe(3);
    expect(alertsFired).toHaveLength(0);
  });

  it("a partial trading day derives as a complete=false row with its decision-time gap", async () => {
    writeFileSync(join(barsDir, "fix-stk-live.csv"), PARTIAL_DAY_CSV);
    await syncSymbols(store, config, { untilMs: NOW.getTime() });
    const row = await store.one(`
      SELECT complete, gap_dir FROM session_features
      WHERE symbol = 'FIX_STK' AND session_key = 'rth' AND trade_date = DATE '2024-01-22'
    `);
    expect(row).not.toBeNull();
    expect(row?.complete).toBe(false);
    expect(row?.gap_dir).toBe("down");
  });

  it("conditions true on the developing row → active, estimate from history only, alert fired", async () => {
    const { setups, alertsFired } = await evaluatePass(store, config, { now: NOW });
    expect(setups).toHaveLength(1);
    const setup = setups[0];
    expect(setup?.phase).toBe("active");
    expect(setup?.tradeDate).toBe("2024-01-22");
    expect(setup?.dsl).toBe("gapFill WHERE gapDir = down");
    // The fixture ledger: 4 gapped-down sessions before 2024-01-22, 2 filled.
    expect(setup?.n).toBe(4);
    expect(setup?.estimate).toBe(0.5);
    expect(setup?.ci95?.[0]).toBeCloseTo(0.15, 3);
    expect(setup?.ci95?.[1]).toBeCloseTo(0.85, 3);
    expect(setup?.lowSample).toBe(true); // 4 < warn floor 5 — shown, flagged
    expect(setup?.evaluatedAt).toBe(NOW.toISOString());
    expect(setup?.id).toMatch(/^FIX_STK\|2024-01-22\|[0-9a-f]{12}$/);

    expect(alertsFired).toHaveLength(1);
    const payload = alertsFired[0];
    if (!payload) throw new Error("expected a fired alert");
    firedPayload = payload;
    expect(payload.v).toBe(1);
    expect(payload.kind).toBe("edge-stats.alert");
    expect(payload.id).toBe(setup?.id);
    expect(payload.firedAt).toBe(NOW.toISOString());
    expect(payload.symbol).toBe("FIX_STK");
    expect(payload.sessionKey).toBe("rth");
    expect(payload.tradeDate).toBe("2024-01-22");
    expect(payload.dsl).toBe("gapFill WHERE gapDir = down");
    expect(payload.estimate).toBe(0.5);
    expect(payload.n).toBe(4);
    expect(payload.ci95).toHaveLength(2);
    expect(payload.threshold).toEqual({ min: 0 });
    expect(payload.storeFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(payload.disclaimer).toContain("Not predictions");
  });

  it("the ndjson sink appends a line that parses back to the v1 payload", async () => {
    await emitAlert(getLiveConfig(config).sinks, firedPayload, {});
    const lines = readFileSync(ndjsonPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "") as AlertPayload;
    expect(parsed).toEqual(firedPayload);
    expect(parsed.v).toBe(1);
    expect(parsed.n).toBe(4);
    expect(parsed.ci95).toHaveLength(2);
  });

  it("writes the live_state meta seam with one setup per watch", async () => {
    const raw = await store.getMeta("live_state");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "") as {
      enabled: boolean;
      updatedAt: string;
      setups: unknown[];
    };
    expect(parsed.enabled).toBe(true);
    expect(parsed.updatedAt).toBe(NOW.toISOString());
    expect(parsed.setups).toHaveLength(1);

    const state = await readLiveState(store);
    expect(state.enabled).toBe(true);
    expect(state.setups[0]?.phase).toBe("active");
  });

  it("dedupes: a second pass on the same trade date fires nothing", async () => {
    const again = await evaluatePass(store, config, { now: NOW });
    expect(again.setups[0]?.phase).toBe("active");
    expect(again.alertsFired).toHaveLength(0);
    const later = await evaluatePass(store, config, {
      now: new Date("2024-01-22T18:45:00.000Z"),
    });
    expect(later.alertsFired).toHaveLength(0);
  });

  it("replay returns the exact stored snapshot behind the alert", async () => {
    const alerts = await listAlerts(store, { limit: 10 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.id).toBe(firedPayload.id);
    expect(alerts[0]?.symbol).toBe("FIX_STK");
    expect(alerts[0]?.query).toBe("gapFill WHERE gapDir = down");

    const snapshot = await replayAlert(store, firedPayload.id);
    expect(snapshot.payload).toEqual(firedPayload);
    expect(snapshot.envelope.n).toBe(4);
    expect(snapshot.envelope.successes).toBe(2);
    // The proof that history never includes the developing session:
    expect(snapshot.envelope.query.until).toBe("2024-01-21");
    expect(snapshot.watch.symbol).toBe("FIX_STK");
    expect(snapshot.evaluatedAt).toBe(NOW.toISOString());

    await expect(replayAlert(store, "no-such-id")).rejects.toThrow(/no alert/);
  });

  it("conditions false on the developing row → forming, no alert", async () => {
    const cfg = withWatches([
      { dsl: "gapFill WHERE gapDir = up", symbol: "FIX_STK", threshold: { min: 0 }, minN: 4 },
    ]);
    const { setups, alertsFired } = await evaluatePass(store, cfg, { now: NOW });
    expect(setups[0]?.phase).toBe("forming");
    expect(alertsFired).toHaveLength(0);
  });

  it("after the session end passes the setup resolves and cannot alert", async () => {
    const { setups, alertsFired } = await evaluatePass(store, config, { now: AFTER_CLOSE });
    expect(setups[0]?.phase).toBe("resolved");
    expect(alertsFired).toHaveLength(0);
  });

  it("respects the minimum-N floor and the threshold bounds", async () => {
    // No watch.minN → the config warn floor (5) applies and n=4 is not enough.
    const floor = await evaluatePass(
      store,
      withWatches([
        { dsl: "gapFill WHERE gapDir = down", symbol: "FIX_STK", threshold: { min: 0.1 } },
      ]),
      { now: NOW },
    );
    expect(floor.setups[0]?.phase).toBe("active");
    expect(floor.alertsFired).toHaveLength(0);

    // Threshold not crossed: estimate 0.5 is not <= max 0.2.
    const bounds = await evaluatePass(
      store,
      withWatches([
        { dsl: "gapFill WHERE gapDir = down", symbol: "FIX_STK", threshold: { max: 0.2 }, minN: 4 },
      ]),
      { now: NOW },
    );
    expect(bounds.setups[0]?.phase).toBe("active");
    expect(bounds.alertsFired).toHaveLength(0);
  });

  it("a preset watch composes to the same query as the raw dsl", async () => {
    const cfg = withWatches([
      {
        preset: "gap-fill",
        params: { dir: "down" },
        symbol: "FIX_STK",
        threshold: { min: 0 },
        minN: 4,
      },
    ]);
    const { setups } = await evaluatePass(store, cfg, { now: NOW });
    expect(setups[0]?.dsl).toBe("gapFill WHERE gapDir = down");
    expect(setups[0]?.phase).toBe("active");
    expect(setups[0]?.n).toBe(4);
  });

  it("records a sync failure note in the state seam", async () => {
    await evaluatePass(store, config, { now: NOW, syncError: "vendor down" });
    const state = await readLiveState(store);
    expect(state.syncError).toBe("vendor down");
    expect(state.setups).toHaveLength(1);
  });

  it("rejects a watch without preset or dsl, and unknown outcomes, loudly", async () => {
    await expect(
      evaluatePass(store, withWatches([{ symbol: "FIX_STK", threshold: {} }]), { now: NOW }),
    ).rejects.toThrow(/needs either a preset or a dsl/);
    await expect(
      evaluatePass(store, withWatches([{ dsl: "gapFll", symbol: "FIX_STK", threshold: {} }]), {
        now: NOW,
      }),
    ).rejects.toThrow(/unknown outcome/);
  });

  it("readLiveState is defensive about garbage in the meta key", async () => {
    await store.setMeta("live_state", "not json at all");
    const state = await readLiveState(store);
    expect(state).toEqual({ enabled: false, updatedAt: null, setups: [] });
    await store.setMeta("live_state", JSON.stringify({ setups: "nope" }));
    expect((await readLiveState(store)).enabled).toBe(false);
  });
});

describe("runLiveLoop", () => {
  it("an already-aborted signal writes enabled:false and returns", async () => {
    const controller = new AbortController();
    controller.abort();
    await runLiveLoop(store, config, { signal: controller.signal, syncFirst: false });
    const state = await readLiveState(store);
    expect(state.enabled).toBe(false);
  });

  it("runs a tick, then marks the state disabled on shutdown", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    let passes = 0;
    await runLiveLoop(store, config, {
      intervalSec: 1,
      signal: controller.signal,
      syncFirst: false,
      log: () => {},
      onPass: () => {
        passes += 1;
      },
    });
    clearTimeout(timer);
    expect(passes).toBeGreaterThanOrEqual(1);
    const state = await readLiveState(store);
    expect(state.enabled).toBe(false);
    expect(state.setups).toHaveLength(1);
    // Real wall-clock now (well past 2024) → the fixture setup reads resolved.
    expect(state.setups[0]?.phase).toBe("resolved");
  });

  it("a vendor hiccup logs and evaluates against the stale store instead of dying", async () => {
    const broken = JSON.parse(JSON.stringify(config)) as EdgeStatsConfig;
    const sym = broken.symbols[0];
    if (!sym) throw new Error("expected a symbol");
    sym.adapterOptions = { ...sym.adapterOptions, path: join(dataDir, "does-not-exist") };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    const logs: string[] = [];
    await runLiveLoop(store, broken, {
      intervalSec: 1,
      signal: controller.signal,
      syncFirst: true,
      log: (msg) => logs.push(msg),
    });
    clearTimeout(timer);
    expect(logs.some((l) => l.includes("sync failed"))).toBe(true);
    expect((await readLiveState(store)).enabled).toBe(false);
  });
});
