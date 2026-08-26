/*
  Sync orchestration: adapters pull bars to the watermark, features derive,
  events refresh. Everything downstream (queries, presets, the Live Board,
  MCP) reads the derived store — sync is the only writer.
*/
import { getAdapter, requireEnv } from "./adapters";
import { makeSessionResolver } from "./calendar";
import type { EdgeStatsConfig, SymbolConfig } from "./config";
import { syncEventsIntoStore } from "./events";
import { deriveFeatures } from "./features/derive";
import type { Store } from "./store/store";

export interface SyncOptions {
  symbols?: string[];
  /** Ignore watermarks and re-pull from scratch (drops the symbol's bars first). */
  full?: boolean;
  log?: (msg: string) => void;
  /** Upper bound for pulls (default: now). Fixed in tests for determinism. */
  untilMs?: number;
}

export interface SymbolSyncSummary {
  symbol: string;
  adapter: string;
  barsInserted: number;
  barsSkipped: number;
  watermark: number | null;
}

export interface SyncSummary {
  symbols: SymbolSyncSummary[];
  events: number;
  derived: { symbol: string; sessionKey: string; sessions: number }[];
}

export async function syncSymbols(
  store: Store,
  config: EdgeStatsConfig,
  opts: SyncOptions = {},
): Promise<SyncSummary> {
  const log = opts.log ?? (() => {});
  const resolver = makeSessionResolver(config, store.dataDir);
  const untilMs = opts.untilMs ?? Date.now();
  const targets = config.symbols.filter((s) => !opts.symbols || opts.symbols.includes(s.symbol));

  const summaries: SymbolSyncSummary[] = [];
  for (const symbol of targets) {
    summaries.push(await syncOne(store, symbol, resolver, untilMs, opts.full === true, log));
  }

  const events = await syncEventsIntoStore(store);
  const { calendarVersionInfo } = await import("./calendar");
  await store.setMeta("calendar_version", calendarVersionInfo(store.dataDir).hash);

  const derived = await deriveFeatures(store, config, resolver, {
    symbols: targets.map((s) => s.symbol),
    log,
  });
  return { symbols: summaries, events, derived };
}

async function syncOne(
  store: Store,
  symbol: SymbolConfig,
  resolver: ReturnType<typeof makeSessionResolver>,
  untilMs: number,
  full: boolean,
  log: (msg: string) => void,
): Promise<SymbolSyncSummary> {
  const adapter = getAdapter(symbol.adapter);
  const ctx = {
    symbol,
    dataDir: store.dataDir,
    env: process.env,
    resolveSessions: (sessionKey: string, fromDate: string, toDate: string) =>
      resolver.resolve(symbol, sessionKey, fromDate, toDate),
    log,
  };
  requireEnv(ctx, adapter);

  if (full) {
    await store.dropBars(symbol.symbol, symbol.tf);
    await store.clearWatermark(symbol.symbol, symbol.tf, adapter.id);
  }
  const watermark = full ? null : await store.getWatermark(symbol.symbol, symbol.tf, adapter.id);

  let inserted = 0;
  let skipped = 0;
  let maxTs: number | null = watermark;
  for await (const batch of adapter.fetchBars(ctx, { sinceMs: watermark, untilMs })) {
    const result = await store.ingestBars(batch, maxTs);
    inserted += result.inserted;
    skipped += result.skipped;
    if (result.maxTs !== null && (maxTs === null || result.maxTs > maxTs)) maxTs = result.maxTs;
  }
  if (maxTs !== null && maxTs !== watermark) {
    await store.setWatermark(symbol.symbol, symbol.tf, adapter.id, maxTs);
  }
  log(`${symbol.symbol}: +${inserted} bars${skipped > 0 ? ` (${skipped} already stored)` : ""}`);
  return {
    symbol: symbol.symbol,
    adapter: adapter.id,
    barsInserted: inserted,
    barsSkipped: skipped,
    watermark: maxTs,
  };
}

export interface FreshnessReport {
  symbols: {
    symbol: string;
    tf: string;
    adapter: string;
    lastBar: string | null;
    lastBarMs: number | null;
  }[];
  calendars: { exchange: string; version: string; coverage: { from: string; to: string } }[];
  calendarHash: string;
  engineVersion: string;
  storeFingerprint: string;
}

export async function freshness(store: Store, config: EdgeStatsConfig): Promise<FreshnessReport> {
  const { calendarVersionInfo } = await import("./calendar");
  const { asNum, asStr } = await import("./util/values");
  const { ENGINE_VERSION } = await import("./version");
  const symbols: FreshnessReport["symbols"] = [];
  for (const s of config.symbols) {
    const row = await store.one(
      `SELECT max(ts) AS m FROM bars WHERE symbol = '${s.symbol.replaceAll("'", "''")}'`,
    );
    const ms = row ? asNum(row.m) : null;
    symbols.push({
      symbol: s.symbol,
      tf: s.tf,
      adapter: s.adapter,
      lastBar: ms !== null ? new Date(ms).toISOString() : null,
      lastBarMs: ms,
    });
  }
  const cal = calendarVersionInfo(store.dataDir);
  return {
    symbols,
    calendars: cal.files.map((f) => ({
      exchange: f.exchange,
      version: asStr(f.version) ?? "",
      coverage: f.coverage,
    })),
    calendarHash: cal.hash,
    engineVersion: ENGINE_VERSION,
    storeFingerprint: await store.fingerprint(),
  };
}
