/*
  The Live Board evaluation engine.

  The honest live semantics, in one paragraph: the probability shown is the
  HISTORICAL conditional estimate — computed by `runQuery` over complete
  sessions only, with `until` pinned to the day before the developing trade
  date so history can never include the session being watched. The
  developing session (the `complete = false` feature row derive writes for
  an in-progress session) is used for exactly one thing: deciding whether
  the watch's WHERE conditions currently hold. Nothing here predicts;
  the board tells you what a setup did historically while it is forming
  in front of you.

  Phases per watch:
    forming  — a developing session exists but the conditions are not
               (yet) true; NULL-dependent conditions (row too young)
               compile to false, so "unknown" reads as forming.
    active   — the developing session exists and the conditions hold.
    resolved — no developing session contains `now` (the session ended,
               or the latest session is already complete).

  Alerts fire only on 'active', only when the historical estimate crosses
  the watch threshold, only at or above the minimum sample size, and at
  most once per (watch, trade date) — the alerts table is the dedupe
  ledger, and every fired alert stores its full evaluation snapshot.

  Determinism: `evaluatePass` takes `now` explicitly and is pure given the
  store contents; `Date.now()` is read only in `runLiveLoop`.
*/
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import type { EdgeStatsConfig } from "../config";
import { defaultSessionKey, findSymbol } from "../config";
import { QueryError } from "../registry";
import { compileConditionExpr } from "../query/compile";
import { compileCtxFor, DISCLAIMER, runQuery } from "../query/execute";
import { parseDsl } from "../query/parser";
import type { Preset } from "../presets/presets";
import { composePresetDsl, findPreset, loadPresets, presetsDir } from "../presets/presets";
import type { Store } from "../store/store";
import { syncSymbols } from "../sync";
import { sqlNum, sqlStr } from "../util/sql";
import { asBool, asInt, asStr } from "../util/values";
import type { AlertPayload, LiveConfig, LiveSetupState, LiveWatch, SetupPhase } from "./types";
import { liveConfigSchema } from "./types";
import type { AlertSnapshot } from "./replay";
import { emitAlert } from "./sinks";

/** The store meta key the board writes and the serve API / MCP tool read. */
export const LIVE_STATE_META_KEY = "live_state";

/** The JSON shape stored under the `live_state` meta key. */
export interface LiveState {
  /** True while a live loop owns the state; flipped to false on shutdown. */
  enabled: boolean;
  updatedAt: string | null;
  setups: LiveSetupState[];
  /**
   * Present when the most recent tick's bar sync failed: the setups were
   * evaluated against the last successfully synced store (stale data).
   */
  syncError?: string;
}

/** Parse `config.live` (an opaque block in the main config) into a LiveConfig. */
export function getLiveConfig(config: EdgeStatsConfig): LiveConfig {
  return liveConfigSchema.parse(config.live ?? {});
}

async function writeLiveState(store: Store, state: LiveState): Promise<void> {
  await store.setMeta(LIVE_STATE_META_KEY, JSON.stringify(state));
}

/**
 * Read the board state seam, defensively: an absent or unparseable value
 * reads as "live is off" rather than an error.
 */
export async function readLiveState(store: Store): Promise<LiveState> {
  const empty: LiveState = { enabled: false, updatedAt: null, setups: [] };
  const raw = await store.getMeta(LIVE_STATE_META_KEY).catch(() => null);
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== "object") return empty;
  const obj = parsed as {
    enabled?: unknown;
    updatedAt?: unknown;
    setups?: unknown;
    syncError?: unknown;
  };
  if (!Array.isArray(obj.setups)) return empty;
  const state: LiveState = {
    enabled: obj.enabled === true,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : null,
    setups: obj.setups as LiveSetupState[],
  };
  if (typeof obj.syncError === "string") state.syncError = obj.syncError;
  return state;
}

/** Deterministic alert id: same watch + same trade date ⇒ same id, always. */
function alertId(
  symbol: string,
  tradeDate: string,
  dsl: string,
  threshold: { min?: number; max?: number },
): string {
  const hash = createHash("sha256")
    .update(dsl)
    .update("|")
    .update(JSON.stringify({ min: threshold.min ?? null, max: threshold.max ?? null }))
    .digest("hex")
    .slice(0, 12);
  return `${symbol}|${tradeDate}|${hash}`;
}

function dayBefore(isoDate: string): string {
  const d = DateTime.fromISO(isoDate, { zone: "utc" }).minus({ days: 1 }).toISODate();
  if (!d) throw new QueryError(`invalid trade date '${isoDate}'`);
  return d;
}

function resolveWatchDsl(watch: LiveWatch, presets: () => Preset[]): string {
  if (watch.preset !== undefined) {
    return composePresetDsl(findPreset(presets(), watch.preset), watch.params ?? {}).dsl;
  }
  if (watch.dsl !== undefined && watch.dsl.trim() !== "") return watch.dsl;
  throw new QueryError(
    `live watch for '${watch.symbol}' needs either a preset or a dsl`,
    'e.g. { "dsl": "gapFill WHERE gapDir = down", "symbol": "…", "threshold": { "min": 0.7 } }',
  );
}

interface DevelopingSession {
  sessionId: string;
  tradeDate: string;
}

/**
 * The developing session: the latest `complete = false` feature row for
 * (symbol, sessionKey) whose [start_ts, end_ts) window contains `now`.
 */
async function findDevelopingSession(
  store: Store,
  symbol: string,
  sessionKey: string,
  nowMs: number,
): Promise<DevelopingSession | null> {
  const row = await store.one(`
    SELECT f.session_id AS session_id, CAST(f.trade_date AS VARCHAR) AS trade_date
    FROM session_features f
    WHERE f.symbol = ${sqlStr(symbol)} AND f.session_key = ${sqlStr(sessionKey)}
      AND NOT f.complete
      AND f.start_ts <= ${sqlNum(nowMs)} AND f.end_ts > ${sqlNum(nowMs)}
    ORDER BY f.trade_date DESC LIMIT 1
  `);
  if (!row) return null;
  const sessionId = asStr(row.session_id);
  const tradeDate = asStr(row.trade_date);
  if (!sessionId || !tradeDate) return null;
  return { sessionId, tradeDate };
}

async function latestTradeDate(
  store: Store,
  symbol: string,
  sessionKey: string,
): Promise<string | null> {
  const row = await store.one(`
    SELECT CAST(max(f.trade_date) AS VARCHAR) AS d FROM session_features f
    WHERE f.symbol = ${sqlStr(symbol)} AND f.session_key = ${sqlStr(sessionKey)}
  `);
  return row ? asStr(row.d) : null;
}

async function alertAlreadyFired(store: Store, id: string): Promise<boolean> {
  const row = await store.one(`SELECT id FROM alerts WHERE id = ${sqlStr(id)}`);
  return row !== null;
}

async function ensureDerivedStore(store: Store): Promise<void> {
  const row = await store.one(`
    SELECT count(*)::INT AS c FROM information_schema.tables
    WHERE table_name = 'session_features'
  `);
  if ((asInt(row?.c) ?? 0) === 0) {
    throw new QueryError(
      "no derived sessions in this store yet",
      "run `edgestats sync` first so session features exist to evaluate against",
    );
  }
}

export interface EvaluatePassOptions {
  /** The evaluation instant — injected for determinism. */
  now: Date;
  /** Set by the loop when this tick's bar sync failed (data is stale). */
  syncError?: string;
}

export interface EvaluatePassResult {
  setups: LiveSetupState[];
  /**
   * Alerts newly recorded by this pass. Each is already inserted into the
   * alerts table with its full snapshot; the caller emits them to sinks.
   */
  alertsFired: AlertPayload[];
}

/**
 * One evaluation pass over every configured watch. Pure given the store
 * contents and `now`. Always writes the `live_state` meta seam.
 */
export async function evaluatePass(
  store: Store,
  config: EdgeStatsConfig,
  opts: EvaluatePassOptions,
): Promise<EvaluatePassResult> {
  const live = getLiveConfig(config);
  const now = opts.now;
  const evaluatedAt = now.toISOString();
  await ensureDerivedStore(store);

  let loadedPresets: Preset[] | null = null;
  const presets = (): Preset[] => {
    loadedPresets ??= loadPresets(presetsDir(store.dataDir));
    return loadedPresets;
  };

  const setups: LiveSetupState[] = [];
  const alertsFired: AlertPayload[] = [];

  for (const watch of live.watch) {
    const symbolCfg = findSymbol(config, watch.symbol);
    const sessionKey = watch.sessionKey ?? defaultSessionKey(symbolCfg);
    const dsl = resolveWatchDsl(watch, presets);
    const ast = parseDsl(dsl);
    const nowMs = now.getTime();

    // 1. Does a developing session exist, and do the conditions hold on it?
    const developing = await findDevelopingSession(store, symbolCfg.symbol, sessionKey, nowMs);
    let phase: SetupPhase;
    if (developing === null) {
      phase = "resolved";
    } else if (ast.where === undefined) {
      phase = "active";
    } else {
      const conditionSql = compileConditionExpr(ast.where, compileCtxFor(symbolCfg));
      const row = await store.one(`
        SELECT (${conditionSql}) AS ok FROM session_features f
        WHERE f.session_id = ${sqlStr(developing.sessionId)}
      `);
      // NULL-dependent conditions coalesce to false: "unknown" is 'forming'.
      phase = asBool(row?.ok) === true ? "active" : "forming";
    }

    const tradeDate =
      developing?.tradeDate ??
      (await latestTradeDate(store, symbolCfg.symbol, sessionKey)) ??
      evaluatedAt.slice(0, 10);

    // 2. The historical estimate: complete sessions only, strictly before
    //    the developing trade date. History never includes the session
    //    being watched.
    const envelope = await runQuery(store, config, {
      dsl,
      symbol: symbolCfg.symbol,
      sessionKey,
      until: dayBefore(tradeDate),
    });
    const normalizedDsl = envelope.query.dsl;
    const id = alertId(symbolCfg.symbol, tradeDate, normalizedDsl, watch.threshold);

    const setup: LiveSetupState = {
      id,
      symbol: symbolCfg.symbol,
      sessionKey,
      tradeDate,
      dsl: normalizedDsl,
      phase,
      estimate: envelope.estimate,
      ci95: envelope.ci95,
      n: envelope.n,
      lowSample: envelope.guards.lowSample,
      evaluatedAt,
    };
    setups.push(setup);

    // 3. Alerting: active phase, estimate present, threshold crossed,
    //    enough history, and not already fired for this trade date.
    const minN = watch.minN ?? config.minN.warn;
    const crossed =
      envelope.estimate !== null &&
      ((watch.threshold.min !== undefined && envelope.estimate >= watch.threshold.min) ||
        (watch.threshold.max !== undefined && envelope.estimate <= watch.threshold.max));
    if (
      phase === "active" &&
      envelope.estimate !== null &&
      envelope.ci95 !== null &&
      crossed &&
      envelope.n >= minN &&
      !(await alertAlreadyFired(store, id))
    ) {
      const payload: AlertPayload = {
        v: 1,
        kind: "edge-stats.alert",
        id,
        firedAt: evaluatedAt,
        symbol: symbolCfg.symbol,
        sessionKey,
        tradeDate,
        dsl: normalizedDsl,
        estimate: envelope.estimate,
        ci95: envelope.ci95,
        n: envelope.n,
        threshold: watch.threshold,
        storeFingerprint: envelope.engine.storeFingerprint,
        disclaimer: DISCLAIMER,
      };
      const snapshot: AlertSnapshot = { payload, envelope, watch, evaluatedAt };
      const firedAtSql = evaluatedAt.replace("T", " ").replace("Z", "");
      await store.run(`
        INSERT OR IGNORE INTO alerts (id, fired_at, symbol, query, snapshot)
        VALUES (${sqlStr(id)}, TIMESTAMP ${sqlStr(firedAtSql)}, ${sqlStr(symbolCfg.symbol)},
                ${sqlStr(normalizedDsl)}, ${sqlStr(JSON.stringify(snapshot))})
      `);
      alertsFired.push(payload);
    }
  }

  // 4. The seam: the serve API and the MCP edge_live tool read this key.
  const state: LiveState = { enabled: true, updatedAt: evaluatedAt, setups };
  if (opts.syncError !== undefined) state.syncError = opts.syncError;
  await writeLiveState(store, state);

  return { setups, alertsFired };
}

export interface LiveLoopOptions {
  /** Override the configured `live.intervalSec` for this run. */
  intervalSec?: number;
  /** Abort to stop the loop; shutdown writes `enabled: false`. */
  signal?: AbortSignal;
  /** Sync watched symbols' bars at the start of every tick. */
  syncFirst: boolean;
  log?: (msg: string) => void;
  /** Env the sinks read secrets from (default process.env). */
  env?: Record<string, string | undefined>;
  /** Called after every pass — the CLI uses it to render the board. */
  onPass?: (result: EvaluatePassResult) => void;
}

/** Read through a call so TS narrowing can't assume abort state is static. */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (isAborted(signal)) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The evaluation loop: every tick syncs the watched symbols (best-effort —
 * a vendor hiccup logs and evaluates against the last synced data instead
 * of killing the loop), evaluates every watch, and emits any new alerts to
 * the sinks. On shutdown the `live_state` seam is rewritten with
 * `enabled: false` so consumers know the board went dark.
 */
export async function runLiveLoop(
  store: Store,
  config: EdgeStatsConfig,
  opts: LiveLoopOptions,
): Promise<void> {
  const live = getLiveConfig(config);
  const intervalSec = opts.intervalSec ?? live.intervalSec;
  const log = opts.log ?? ((msg: string) => console.error(msg));
  const env = opts.env ?? process.env;
  const symbols = [...new Set(live.watch.map((w) => w.symbol))];
  let lastSetups: LiveSetupState[] = [];

  try {
    while (!isAborted(opts.signal)) {
      // The only wall-clock read: everything below is deterministic in `now`.
      const now = new Date();
      let syncError: string | undefined;
      if (opts.syncFirst && symbols.length > 0) {
        try {
          await syncSymbols(store, config, { symbols, untilMs: now.getTime(), log });
        } catch (err) {
          syncError = err instanceof Error ? err.message : String(err);
          log(`live: sync failed (${syncError}) — evaluating against the last synced data`);
        }
      }
      const passOpts: EvaluatePassOptions = syncError === undefined ? { now } : { now, syncError };
      const result = await evaluatePass(store, config, passOpts);
      lastSetups = result.setups;
      for (const payload of result.alertsFired) {
        await emitAlert(live.sinks, payload, env);
      }
      opts.onPass?.(result);
      if (isAborted(opts.signal)) break;
      await sleep(intervalSec * 1000, opts.signal);
    }
  } finally {
    await writeLiveState(store, {
      enabled: false,
      updatedAt: new Date().toISOString(),
      setups: lastSetups,
    });
  }
}
