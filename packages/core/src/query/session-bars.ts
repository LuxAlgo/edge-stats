/*
  Session view: the raw bars behind ONE session, plus the levels the engine
  derived for it (prior high/low/close, session open, opening ranges, gap,
  fill/touch/break times), so a statistic like "gap filled 80%" can be
  checked against what a matched session actually looked like.

  Performance stance: bars are read straight from the (symbol, tf, year)
  parquet partition(s) the session falls in — one file set, occasionally two
  at a year boundary — never through a scan of the whole bar history. The
  size of the user's store therefore has no effect on a session view: a
  session over ten years of 1-minute bars costs the same as over ten days.

  Bounded by construction: one session per call, a hard ceiling on the
  session window and on returned bars, and a capped pre-session context.
*/
import { DateTime } from "luxon";
import { sessionDefsFor } from "../calendar/sessions";
import type { EdgeStatsConfig, SymbolConfig } from "../config";
import { findSymbol, parseTfMs } from "../config";
import { QueryError } from "../registry";
import type { Store } from "../store/store";
import { sqlNum, sqlPath, sqlStr } from "../util/sql";
import { asBool, asInt, asNum, asStr } from "../util/values";
import { compileCtxFor } from "./execute";
import { DISCLAIMER } from "./execute";

export interface SessionBar {
  /** UTC epoch milliseconds of the bar's open. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SessionOpeningRange {
  /** Window length in minutes from the open. */
  window: number;
  high: number | null;
  low: number | null;
  firstBreak: "up" | "down" | "none" | null;
  /** Minutes from the open to the first break, when one happened. */
  breakMin: number | null;
}

export interface SessionLevels {
  prevClose: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  prevMid: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  gapAbs: number | null;
  gapPct: number | null;
  gapDir: "up" | "down" | "none" | null;
  gapFilled: boolean | null;
  touchedPrevHigh: boolean | null;
  touchedPrevLow: boolean | null;
  ibBreak: string | null;
  /** The initial-balance window (minutes) configured for the symbol. */
  ibWindow: number;
  /** Every opening-range window derived for the symbol. */
  openingRanges: SessionOpeningRange[];
}

/** Minutes from the session open to each derived event, when it happened. */
export interface SessionTimes {
  gapFillMin: number | null;
  touchPrevHighMin: number | null;
  touchPrevLowMin: number | null;
  highTimeMin: number | null;
  lowTimeMin: number | null;
}

export interface SessionContext {
  /**
   * The last bars before the session open, oldest first. `pre-session` means
   * they run contiguously into the open (pre-market / extended hours the
   * store holds); `prior-session` means they are the tail of the previous
   * trading session; `none` means the store has no earlier bars.
   */
  kind: "pre-session" | "prior-session" | "none";
  bars: SessionBar[];
  note: string;
}

export interface SessionBarsResult {
  sessionId: string;
  symbol: string;
  sessionKey: string;
  tradeDate: string;
  /** The store's base timeframe the bars are at (e.g. "1m"). */
  tf: string;
  /** IANA timezone the session window is defined in. */
  tz: string;
  /** Session window, UTC ms: [startTs, endTs). */
  startTs: number;
  endTs: number;
  isHalfDay: boolean;
  isRollDay: boolean;
  complete: boolean;
  /** Bars strictly inside the session window, oldest first. */
  bars: SessionBar[];
  context: SessionContext;
  levels: SessionLevels;
  times: SessionTimes;
  disclaimer: string;
}

export interface SessionBarsOptions {
  /** Pre-session context bars to include (default 30, max 240, 0 for none). */
  contextBars?: number;
}

export const SESSION_BARS_DEFAULT_CONTEXT = 30;
export const SESSION_BARS_MAX_CONTEXT = 240;
/** A session longer than this is not a session; refuse rather than scan. */
const MAX_SESSION_MS = 36 * 3_600_000;
/** Ceiling on bars returned for one session (1m bars over 36h is 2,160). */
const MAX_SESSION_BARS = 5_000;
/** How far back the context lookup may reach: a long weekend plus a holiday. */
const CONTEXT_LOOKBACK_MS = 7 * 86_400_000;

function toBar(r: Record<string, unknown>): SessionBar {
  return {
    ts: asNum(r.ts) ?? 0,
    open: asNum(r.open) ?? 0,
    high: asNum(r.high) ?? 0,
    low: asNum(r.low) ?? 0,
    close: asNum(r.close) ?? 0,
    volume: asNum(r.volume) ?? 0,
  };
}

function yearsSpanning(fromMs: number, toMs: number): number[] {
  const a = DateTime.fromMillis(fromMs, { zone: "utc" }).year;
  const b = DateTime.fromMillis(toMs, { zone: "utc" }).year;
  const years: number[] = [];
  for (let y = a; y <= b; y += 1) years.push(y);
  return years;
}

function gapDirOf(v: unknown): SessionLevels["gapDir"] {
  const s = asStr(v);
  return s === "up" || s === "down" || s === "none" ? s : null;
}

function firstBreakOf(v: unknown): SessionOpeningRange["firstBreak"] {
  const s = asStr(v);
  return s === "up" || s === "down" || s === "none" ? s : null;
}

function levelsFrom(row: Record<string, unknown>, symbol: SymbolConfig): SessionLevels {
  const { orWindows, ibWindow } = compileCtxFor(symbol);
  const openingRanges: SessionOpeningRange[] = orWindows
    .filter((w) => `or${w}_high` in row)
    .map((w) => ({
      window: w,
      high: asNum(row[`or${w}_high`]),
      low: asNum(row[`or${w}_low`]),
      firstBreak: firstBreakOf(row[`or${w}_first_break`]),
      breakMin: asInt(row[`or${w}_break_min`]),
    }));
  return {
    prevClose: asNum(row.prev_close),
    prevHigh: asNum(row.prev_high),
    prevLow: asNum(row.prev_low),
    prevMid: asNum(row.prev_mid),
    open: asNum(row.open),
    high: asNum(row.high),
    low: asNum(row.low),
    close: asNum(row.close),
    gapAbs: asNum(row.gap_abs),
    gapPct: asNum(row.gap_pct),
    gapDir: gapDirOf(row.gap_dir),
    gapFilled: asBool(row.gap_filled),
    touchedPrevHigh: asBool(row.touched_prev_high),
    touchedPrevLow: asBool(row.touched_prev_low),
    ibBreak: asStr(row.ib_break),
    ibWindow,
    openingRanges,
  };
}

/**
 * One session's bars at the store's base timeframe, with the derived levels
 * and event times from its `session_features` row. Session ids come from a
 * result's `sessions[].sessionId` (or `edge_sessions` over MCP).
 */
export async function getSessionBars(
  store: Store,
  config: EdgeStatsConfig,
  sessionId: string,
  opts: SessionBarsOptions = {},
): Promise<SessionBarsResult> {
  const contextBars = opts.contextBars ?? SESSION_BARS_DEFAULT_CONTEXT;
  if (!Number.isInteger(contextBars) || contextBars < 0 || contextBars > SESSION_BARS_MAX_CONTEXT) {
    throw new QueryError(
      `contextBars must be an integer between 0 and ${SESSION_BARS_MAX_CONTEXT}`,
      "the pre-session context is a handful of bars for orientation, not a second session",
    );
  }

  const row = await store.one(`
    SELECT * REPLACE (CAST(trade_date AS VARCHAR) AS trade_date)
    FROM session_features WHERE session_id = ${sqlStr(sessionId)}
  `);
  if (!row) {
    throw new QueryError(
      `unknown session '${sessionId}'`,
      "session ids come from a query result's sessions[].sessionId, e.g. 'DEMO_STK|rth|2024-12-27'",
    );
  }

  const symbolName = asStr(row.symbol) ?? "";
  const sessionKey = asStr(row.session_key) ?? "";
  let symbol: SymbolConfig;
  try {
    symbol = findSymbol(config, symbolName);
  } catch (err) {
    throw new QueryError(
      err instanceof Error ? err.message : String(err),
      "the session's symbol is no longer configured, so its bar partition cannot be located",
    );
  }
  const tf = symbol.tf;
  const tfMs = parseTfMs(tf);
  const tz = sessionDefsFor(symbol)[sessionKey]?.tz ?? "UTC";

  const startTs = asNum(row.start_ts);
  const endTs = asNum(row.end_ts);
  if (startTs === null || endTs === null || endTs <= startTs) {
    throw new QueryError(`session '${sessionId}' has no valid window`);
  }
  if (endTs - startTs > MAX_SESSION_MS) {
    throw new QueryError(
      `session '${sessionId}' spans ${Math.round((endTs - startTs) / 3_600_000)} hours; the session view is capped at ${MAX_SESSION_MS / 3_600_000}`,
      "check the session definition in edge-stats.config.json",
    );
  }

  // One session ⇒ one (symbol, tf, year) partition, two at a year boundary or
  // when the context lookback crosses into the previous year. Nothing else
  // in the store is opened.
  const contextFrom = startTs - CONTEXT_LOOKBACK_MS;
  const globs = store.barPartitionGlobs(symbolName, tf, yearsSpanning(contextFrom, endTs));
  let bars: SessionBar[] = [];
  let context: SessionBar[] = [];
  if (globs.length > 0) {
    const source = `read_parquet([${globs.map((g) => sqlPath(g)).join(", ")}], union_by_name = true)`;
    const sessionRows = await store.all(`
      SELECT ts, open, high, low, close, volume FROM ${source}
      WHERE ts >= ${sqlNum(startTs)} AND ts < ${sqlNum(endTs)}
      ORDER BY ts LIMIT ${MAX_SESSION_BARS + 1}
    `);
    if (sessionRows.length > MAX_SESSION_BARS) {
      throw new QueryError(
        `session '${sessionId}' holds more than ${MAX_SESSION_BARS} bars at ${tf}`,
        "the session view shows one session at the store's base timeframe; this window is too dense to be one",
      );
    }
    bars = sessionRows.map(toBar);
    if (contextBars > 0) {
      const contextRows = await store.all(`
        SELECT ts, open, high, low, close, volume FROM ${source}
        WHERE ts >= ${sqlNum(contextFrom)} AND ts < ${sqlNum(startTs)}
        ORDER BY ts DESC LIMIT ${contextBars}
      `);
      context = contextRows.map(toBar).reverse();
    }
  }

  const lastContext = context[context.length - 1];
  const kind: SessionContext["kind"] =
    lastContext === undefined
      ? "none"
      : startTs - lastContext.ts <= 2 * tfMs
        ? "pre-session"
        : "prior-session";
  const note =
    kind === "none"
      ? "No bars before this session's open are in the store."
      : kind === "pre-session"
        ? `${context.length} bars running into the open (pre-session / extended hours). Not part of the session; shown for orientation only.`
        : `${context.length} bars from the tail of the previous trading session. Not part of the session; shown for orientation only.`;

  return {
    sessionId,
    symbol: symbolName,
    sessionKey,
    tradeDate: asStr(row.trade_date) ?? "",
    tf,
    tz,
    startTs,
    endTs,
    isHalfDay: asBool(row.is_half_day) ?? false,
    isRollDay: asBool(row.is_roll_day) ?? false,
    complete: asBool(row.complete) ?? false,
    bars,
    context: { kind, bars: context, note },
    levels: levelsFrom(row, symbol),
    times: {
      gapFillMin: asInt(row.gap_fill_min),
      touchPrevHighMin: asInt(row.touch_prev_high_min),
      touchPrevLowMin: asInt(row.touch_prev_low_min),
      highTimeMin: asInt(row.high_time_min),
      lowTimeMin: asInt(row.low_time_min),
    },
    disclaimer: DISCLAIMER,
  };
}
