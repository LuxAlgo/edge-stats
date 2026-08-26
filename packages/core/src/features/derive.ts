/*
  Feature derivation: bars + calendars → one wide session_features row per
  (symbol, session, session window). Runs once at sync so queries stay
  interactive over years of data.

  Four stages per (symbol, session key):
    S1 (SQL)  per-session bar aggregates + opening-range levels
    S2 (SQL)  scans that need S1 levels: break times, extensions, hi/lo times
    S3 (TS)   cross-session state: prev levels, gaps, rolls, streaks, ATR,
              patterns, FVG zones, next-session outcomes
    S4 (SQL)  scans that need S3 params (gap-fill time, prior-level touches),
              then assembly + insert

  Correctness stances baked in here:
  - A gap across a futures roll is a roll, not a gap: gap and prior-level
    features are NULL on roll days (the rollDay field isolates them).
  - No lookahead in decision-time features: FVG zones form on prior
    sessions; ATR/streaks describe sessions strictly before the open.
  - Sessions with incomplete bar coverage are flagged complete = false and
    excluded from historical queries.
*/
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { SessionResolver } from "../calendar";
import type { EdgeStatsConfig, SymbolConfig } from "../config";
import { parseTfMs } from "../config";
import { derivableSessionKeys } from "../calendar/sessions";
import type { Store } from "../store/store";
import { sqlNum, sqlPath, sqlStr } from "../util/sql";
import { asInt, asNum, asStr, round } from "../util/values";
import { featureColumns, featuresDdl } from "./schema";

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

interface S1Row {
  tradeDate: string;
  startTs: number;
  endTs: number;
  isHalfDay: boolean;
  barCount: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  firstTs: number;
  lastTs: number;
  contractFirst: string | null;
  contractLast: string | null;
  highTs: number | null;
  lowTs: number | null;
  or: Map<number, OrRow>;
}

interface OrRow {
  high: number | null;
  low: number | null;
  bars: number;
  upTs: number | null;
  dnTs: number | null;
  postHigh: number | null;
  postLow: number | null;
}

interface FvgZone {
  lo: number;
  hi: number;
  side: "bull" | "bear";
}

export interface DeriveSummary {
  symbol: string;
  sessionKey: string;
  sessions: number;
}

function gapBucket(absPct: number): string {
  if (absPct < 0.15) return "xs";
  if (absPct < 0.3) return "s";
  if (absPct < 0.75) return "m";
  if (absPct < 1.5) return "l";
  return "xl";
}

async function ensureFeaturesTable(store: Store, windows: number[]): Promise<boolean> {
  const wanted = featureColumns(windows).map((c) => c.name);
  const existing = await store
    .all(`SELECT name FROM pragma_table_info('session_features')`)
    .catch(() => null);
  if (existing !== null && existing.length > 0) {
    const have = new Set(existing.map((r) => asStr(r.name)));
    if (wanted.every((c) => have.has(c)) && have.size === wanted.length) return false;
    await store.run("DROP TABLE session_features");
  }
  await store.run(featuresDdl(windows));
  return true;
}

function unionWindows(config: EdgeStatsConfig): number[] {
  const set = new Set<number>();
  for (const s of config.symbols) {
    for (const w of s.orWindows) set.add(w);
    set.add(s.ibWindow);
  }
  if (set.size === 0) for (const w of [5, 10, 15, 30, 60]) set.add(w);
  return [...set].sort((a, b) => a - b);
}

export interface DeriveOptions {
  symbols?: string[];
  log?: (msg: string) => void;
}

export async function deriveFeatures(
  store: Store,
  config: EdgeStatsConfig,
  resolver: SessionResolver,
  opts: DeriveOptions = {},
): Promise<DeriveSummary[]> {
  const log = opts.log ?? (() => {});
  const windows = unionWindows(config);
  const recreated = await ensureFeaturesTable(store, windows);
  const symbols = recreated
    ? config.symbols
    : config.symbols.filter((s) => !opts.symbols || opts.symbols.includes(s.symbol));

  const summaries: DeriveSummary[] = [];
  for (const symbol of symbols) {
    for (const sessionKey of derivableSessionKeys(symbol)) {
      const count = await deriveOne(store, symbol, sessionKey, windows, resolver, log);
      summaries.push({ symbol: symbol.symbol, sessionKey, sessions: count });
    }
  }
  return summaries;
}

async function deriveOne(
  store: Store,
  symbol: SymbolConfig,
  sessionKey: string,
  windows: number[],
  resolver: SessionResolver,
  log: (msg: string) => void,
): Promise<number> {
  const sym = sqlStr(symbol.symbol);
  const tf = sqlStr(symbol.tf);
  const tfMs = parseTfMs(symbol.tf);

  const span = await store.one(
    `SELECT min(ts) AS lo, max(ts) AS hi FROM bars WHERE symbol = ${sym} AND tf = ${tf}`,
  );
  const lo = asNum(span?.lo);
  const hi = asNum(span?.hi);
  if (lo === null || hi === null) {
    await store.run(
      `DELETE FROM session_features WHERE symbol = ${sym} AND session_key = ${sqlStr(sessionKey)}`,
    );
    return 0;
  }

  const fromDate = DateTime.fromMillis(lo, { zone: "utc" }).minus({ days: 3 }).toISODate();
  const toDate = DateTime.fromMillis(hi, { zone: "utc" }).plus({ days: 2 }).toISODate();
  if (!fromDate || !toDate) throw new Error("invalid bar span");
  const sessions = resolver.resolve(symbol, sessionKey, fromDate, toDate);
  if (sessions.length === 0) return 0;

  // _sess: the resolved calendar windows
  await store.run(
    "CREATE OR REPLACE TEMP TABLE _sess (trade_date DATE, start_ts BIGINT, end_ts BIGINT, is_half_day BOOLEAN)",
  );
  for (let i = 0; i < sessions.length; i += 500) {
    const chunk = sessions.slice(i, i + 500);
    const values = chunk
      .map(
        (s) =>
          `(DATE ${sqlStr(s.tradeDate)}, ${sqlNum(s.startMs)}, ${sqlNum(s.endMs)}, ${s.isHalfDay ? "TRUE" : "FALSE"})`,
      )
      .join(", ");
    await store.run(`INSERT INTO _sess VALUES ${values}`);
  }

  const barsJoin = `JOIN bars b ON b.symbol = ${sym} AND b.tf = ${tf} AND b.ts >= s.start_ts AND b.ts < s.end_ts`;

  // S1: per-session aggregates + OR levels in one pass over bars
  const orLevelSelects = windows
    .map(
      (w) => `
      max(b.high) FILTER (WHERE b.ts < s.start_ts + ${w * 60000}) AS or${w}_high,
      min(b.low) FILTER (WHERE b.ts < s.start_ts + ${w * 60000}) AS or${w}_low,
      count(*) FILTER (WHERE b.ts < s.start_ts + ${w * 60000})::INT AS or${w}_bars`,
    )
    .join(",");
  await store.run(`
    CREATE OR REPLACE TEMP TABLE _s1 AS
    SELECT s.trade_date, any_value(s.start_ts) AS start_ts, any_value(s.end_ts) AS end_ts,
      any_value(s.is_half_day) AS is_half_day,
      count(*)::INT AS bar_count,
      arg_min(b.open, b.ts) AS open, max(b.high) AS high, min(b.low) AS low,
      arg_max(b.close, b.ts) AS close, sum(b.volume) AS volume,
      min(b.ts) AS first_ts, max(b.ts) AS last_ts,
      arg_min(b.contract, b.ts) AS contract_first, arg_max(b.contract, b.ts) AS contract_last,
      ${orLevelSelects}
    FROM _sess s ${barsJoin}
    GROUP BY s.trade_date
  `);

  // S2: scans that need S1 levels
  const orBreakSelects = windows
    .map(
      (w) => `
      min(b.ts) FILTER (WHERE b.ts >= s.start_ts + ${w * 60000} AND b.high > s.or${w}_high) AS or${w}_up_ts,
      min(b.ts) FILTER (WHERE b.ts >= s.start_ts + ${w * 60000} AND b.low < s.or${w}_low) AS or${w}_dn_ts,
      max(b.high) FILTER (WHERE b.ts >= s.start_ts + ${w * 60000}) AS or${w}_post_high,
      min(b.low) FILTER (WHERE b.ts >= s.start_ts + ${w * 60000}) AS or${w}_post_low`,
    )
    .join(",");
  await store.run(`
    CREATE OR REPLACE TEMP TABLE _s2 AS
    SELECT s.trade_date,
      min(b.ts) FILTER (WHERE b.high >= s.high) AS high_ts,
      min(b.ts) FILTER (WHERE b.low <= s.low) AS low_ts,
      ${orBreakSelects}
    FROM _s1 s JOIN bars b ON b.symbol = ${sym} AND b.tf = ${tf} AND b.ts >= s.start_ts AND b.ts < s.end_ts
    GROUP BY s.trade_date
  `);

  const s1Rows = await store.all(`
    SELECT s1.*, s2.* EXCLUDE (trade_date),
      CAST(s1.trade_date AS VARCHAR) AS trade_date_str
    FROM _s1 s1 JOIN _s2 s2 USING (trade_date)
    ORDER BY s1.trade_date
  `);

  const rows: S1Row[] = s1Rows.map((r) => {
    const or = new Map<number, OrRow>();
    for (const w of windows) {
      or.set(w, {
        high: asNum(r[`or${w}_high`]),
        low: asNum(r[`or${w}_low`]),
        bars: asInt(r[`or${w}_bars`]) ?? 0,
        upTs: asNum(r[`or${w}_up_ts`]),
        dnTs: asNum(r[`or${w}_dn_ts`]),
        postHigh: asNum(r[`or${w}_post_high`]),
        postLow: asNum(r[`or${w}_post_low`]),
      });
    }
    return {
      tradeDate: asStr(r.trade_date_str) ?? "",
      startTs: asNum(r.start_ts) ?? 0,
      endTs: asNum(r.end_ts) ?? 0,
      isHalfDay: r.is_half_day === true,
      barCount: asInt(r.bar_count) ?? 0,
      open: asNum(r.open) ?? 0,
      high: asNum(r.high) ?? 0,
      low: asNum(r.low) ?? 0,
      close: asNum(r.close) ?? 0,
      volume: asNum(r.volume) ?? 0,
      firstTs: asNum(r.first_ts) ?? 0,
      lastTs: asNum(r.last_ts) ?? 0,
      contractFirst: asStr(r.contract_first),
      contractLast: asStr(r.contract_last),
      highTs: asNum(r.high_ts),
      lowTs: asNum(r.low_ts),
      or,
    };
  });

  // S3 (TS): cross-session state
  const grace = Math.max(2 * tfMs, 15 * 60000);
  const zones: FvgZone[] = [];
  const out: Record<string, unknown>[] = [];
  const scanParams: {
    tradeDate: string;
    prevClose: number;
    prevHigh: number;
    prevLow: number;
    gapDir: string;
  }[] = [];

  let greenStreak = 0;
  let redStreak = 0;
  const trHistory: number[] = [];
  const rangeHistory: number[] = [];
  const volHistory: number[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const cur = rows[i];
    if (!cur) continue;
    const prev = i > 0 ? (rows[i - 1] ?? null) : null;
    const dt = DateTime.fromISO(cur.tradeDate, { zone: "utc" });
    const dow = WEEKDAY_NAMES[dt.weekday - 1] ?? "Mon";

    const isRoll =
      prev !== null &&
      ((cur.contractFirst !== null &&
        prev.contractLast !== null &&
        cur.contractFirst !== prev.contractLast) ||
        (cur.contractFirst !== null &&
          cur.contractLast !== null &&
          cur.contractFirst !== cur.contractLast));

    const complete =
      cur.barCount > 0 &&
      cur.firstTs <= cur.startTs + grace &&
      cur.lastTs >= cur.endTs - grace - tfMs;

    const rangeAbs = cur.high - cur.low;
    const green = cur.close > cur.open;
    const retOcPct = cur.open !== 0 ? (100 * (cur.close - cur.open)) / cur.open : null;

    // Prior-session-derived features (NULL across a roll)
    const usePrev = prev !== null && !isRoll;
    const prevClose = usePrev ? prev.close : null;
    const prevHigh = usePrev ? prev.high : null;
    const prevLow = usePrev ? prev.low : null;
    const prevRange = usePrev && prevHigh !== null && prevLow !== null ? prevHigh - prevLow : null;

    let gapAbs: number | null = null;
    let gapPct: number | null = null;
    let gapDir: string | null = null;
    if (prevClose !== null && prevClose !== 0) {
      gapAbs = cur.open - prevClose;
      gapPct = (100 * gapAbs) / prevClose;
      gapDir = gapAbs > 0 ? "up" : gapAbs < 0 ? "down" : "none";
    }

    if (prevClose !== null && prevHigh !== null && prevLow !== null && gapDir !== null) {
      scanParams.push({
        tradeDate: cur.tradeDate,
        prevClose,
        prevHigh,
        prevLow,
        gapDir,
      });
    }

    // ATR(14) and averages describe sessions strictly BEFORE this one.
    const atr =
      trHistory.length >= 14 ? trHistory.slice(-14).reduce((a, b) => a + b, 0) / 14 : null;
    const atrPct =
      atr !== null && prevClose !== null && prevClose !== 0 ? (100 * atr) / prevClose : null;
    const volAvg20 =
      volHistory.length >= 20 ? volHistory.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;

    // NR4/NR7: narrowest of the last 4/7 including this session.
    const last3 = rangeHistory.slice(-3);
    const last6 = rangeHistory.slice(-6);
    const nr4 = last3.length === 3 && last3.every((r) => rangeAbs < r);
    const nr7 = last6.length === 6 && last6.every((r) => rangeAbs < r);

    const insideDay =
      usePrev &&
      prevHigh !== null &&
      prevLow !== null &&
      cur.high <= prevHigh &&
      cur.low >= prevLow;
    const outsideDay =
      usePrev && prevHigh !== null && prevLow !== null && cur.high > prevHigh && cur.low < prevLow;

    const prevGreen = prev !== null ? prev.close > prev.open : null;
    const bullEngulf =
      usePrev &&
      prev !== null &&
      prev.close < prev.open &&
      green &&
      cur.open <= prev.close &&
      cur.close >= prev.open;
    const bearEngulf =
      usePrev &&
      prev !== null &&
      prev.close > prev.open &&
      !green &&
      cur.close <= cur.open &&
      cur.open >= prev.close &&
      cur.close <= prev.open;
    const doji = rangeAbs > 0 && Math.abs(cur.close - cur.open) <= 0.1 * rangeAbs;

    // FVG state uses zones formed on sessions strictly before this one.
    const fvgBelow = zones.some((z) => z.side === "bull" && z.hi < cur.open);
    const fvgAbove = zones.some((z) => z.side === "bear" && z.lo > cur.open);

    const row: Record<string, unknown> = {
      symbol: symbol.symbol,
      session_key: sessionKey,
      trade_date: cur.tradeDate,
      session_id: `${symbol.symbol}|${sessionKey}|${cur.tradeDate}`,
      start_ts: cur.startTs,
      end_ts: cur.endTs,
      is_half_day: cur.isHalfDay,
      is_roll_day: isRoll,
      complete,
      bar_count: cur.barCount,
      dow,
      month: dt.month,
      year: dt.year,
      open: cur.open,
      high: cur.high,
      low: cur.low,
      close: cur.close,
      volume: cur.volume,
      range_abs: rangeAbs,
      range_pct: cur.open !== 0 ? round((100 * rangeAbs) / cur.open, 6) : null,
      ret_oc_pct: retOcPct !== null ? round(retOcPct, 6) : null,
      green,
      high_time_min: cur.highTs !== null ? Math.floor((cur.highTs - cur.startTs) / 60000) : null,
      low_time_min: cur.lowTs !== null ? Math.floor((cur.lowTs - cur.startTs) / 60000) : null,
      high_before_low: cur.highTs !== null && cur.lowTs !== null ? cur.highTs < cur.lowTs : null,
      prev_close: prevClose,
      prev_high: prevHigh,
      prev_low: prevLow,
      prev_mid: prevHigh !== null && prevLow !== null ? (prevHigh + prevLow) / 2 : null,
      prev_range: prevRange,
      gap_abs: gapAbs,
      gap_pct: gapPct !== null ? round(gapPct, 6) : null,
      abs_gap_pct: gapPct !== null ? round(Math.abs(gapPct), 6) : null,
      gap_dir: gapDir,
      gap_bucket: gapPct !== null && gapDir !== "none" ? gapBucket(Math.abs(gapPct)) : null,
      // gap_filled / gap_fill_min / gap_reversed / touches arrive from S4
      gap_filled: null,
      gap_fill_min: null,
      gap_reversed: null,
      open_pos_prev_range:
        prevRange !== null && prevRange > 0 && prevLow !== null
          ? round((cur.open - prevLow) / prevRange, 6)
          : null,
      open_above_prev_high: prevHigh !== null ? cur.open > prevHigh : null,
      open_below_prev_low: prevLow !== null ? cur.open < prevLow : null,
      touched_prev_high: null,
      touch_prev_high_min: null,
      touched_prev_low: null,
      touch_prev_low_min: null,
      closed_above_prev_high: prevHigh !== null ? cur.close > prevHigh : null,
      closed_below_prev_low: prevLow !== null ? cur.close < prevLow : null,
      inside_day: usePrev ? insideDay : null,
      outside_day: usePrev ? outsideDay : null,
      nr4,
      nr7,
      bull_engulf: usePrev ? bullEngulf : null,
      bear_engulf: usePrev ? bearEngulf : null,
      doji,
      atr14_pct: atrPct !== null ? round(atrPct, 6) : null,
      range_vs_atr: atr !== null && atr > 0 ? round(rangeAbs / atr, 6) : null,
      vol_vs_avg20: volAvg20 !== null && volAvg20 > 0 ? round(cur.volume / volAvg20, 6) : null,
      prev_green_streak: greenStreak,
      prev_red_streak: redStreak,
      prev_day_green: prevGreen,
      fvg_above: fvgAbove,
      fvg_below: fvgBelow,
      next_green: null,
      next_ret_oc_pct: null,
      next_range_pct: null,
      next_range_vs_atr: null,
      // Prior-session shape lags: what yesterday looked like, known at the
      // open. NULL across rolls like every other prior-session feature.
      prev_inside_day: usePrev ? (out[out.length - 1]?.inside_day ?? null) : null,
      prev_nr7: usePrev ? (out[out.length - 1]?.nr7 ?? null) : null,
      prev_doji: usePrev ? (out[out.length - 1]?.doji ?? null) : null,
      ib_break: null,
    };

    // Opening-range features
    for (const w of windows) {
      const o = cur.or.get(w);
      const p = `or${w}_`;
      if (!o || o.high === null || o.low === null || o.bars === 0 || cur.barCount <= o.bars) {
        row[`${p}high`] = null;
        row[`${p}low`] = null;
        row[`${p}range`] = null;
        row[`${p}first_break`] = null;
        row[`${p}break_min`] = null;
        row[`${p}false_break`] = null;
        row[`${p}broke_both`] = null;
        row[`${p}ext_up_r`] = null;
        row[`${p}ext_dn_r`] = null;
        continue;
      }
      const range = o.high - o.low;
      const first =
        o.upTs !== null && (o.dnTs === null || o.upTs <= o.dnTs)
          ? "up"
          : o.dnTs !== null
            ? "down"
            : "none";
      const firstTs = first === "up" ? o.upTs : first === "down" ? o.dnTs : null;
      const falseBreak =
        first === "up" ? cur.close < o.high : first === "down" ? cur.close > o.low : null;
      row[`${p}high`] = o.high;
      row[`${p}low`] = o.low;
      row[`${p}range`] = range;
      row[`${p}first_break`] = first;
      row[`${p}break_min`] = firstTs !== null ? Math.floor((firstTs - cur.startTs) / 60000) : null;
      row[`${p}false_break`] = falseBreak;
      row[`${p}broke_both`] = o.upTs !== null && o.dnTs !== null;
      row[`${p}ext_up_r`] =
        o.upTs !== null && o.postHigh !== null && range > 0
          ? round(Math.max(0, o.postHigh - o.high) / range, 6)
          : null;
      row[`${p}ext_dn_r`] =
        o.dnTs !== null && o.postLow !== null && range > 0
          ? round(Math.max(0, o.low - o.postLow) / range, 6)
          : null;
    }

    // Initial balance classification from the IB window's OR features
    const ib = cur.or.get(symbol.ibWindow);
    if (ib && ib.high !== null && ib.low !== null && ib.bars > 0 && cur.barCount > ib.bars) {
      const up = ib.upTs !== null;
      const dn = ib.dnTs !== null;
      row.ib_break = up && dn ? "double" : up ? "single_up" : dn ? "single_down" : "none";
    }

    out.push(row);

    // Roll histories forward AFTER computing this session's decision-time features.
    if (prevClose !== null) {
      trHistory.push(
        Math.max(rangeAbs, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)),
      );
    } else {
      trHistory.push(rangeAbs);
    }
    rangeHistory.push(rangeAbs);
    volHistory.push(cur.volume);
    if (green) {
      greenStreak += 1;
      redStreak = 0;
    } else if (cur.close < cur.open) {
      redStreak += 1;
      greenStreak = 0;
    } else {
      greenStreak = 0;
      redStreak = 0;
    }

    // Fill existing zones with this session's range, then form new zones.
    for (let z = zones.length - 1; z >= 0; z -= 1) {
      const zone = zones[z];
      if (!zone) continue;
      const pierced = zone.side === "bull" ? cur.low <= zone.lo : cur.high >= zone.hi;
      if (pierced) zones.splice(z, 1);
    }
    const prev2 = i >= 2 ? rows[i - 2] : null;
    if (prev2 && cur.low > prev2.high) {
      zones.push({ lo: prev2.high, hi: cur.low, side: "bull" });
    }
    if (prev2 && cur.high < prev2.low) {
      zones.push({ lo: cur.high, hi: prev2.low, side: "bear" });
    }
    while (zones.length > 60) zones.shift();
  }

  // next-session outcomes
  for (let i = 0; i < out.length - 1; i += 1) {
    const cur = out[i];
    const next = out[i + 1];
    if (!cur || !next) continue;
    cur.next_green = next.green;
    cur.next_ret_oc_pct = next.ret_oc_pct;
    cur.next_range_pct = next.range_pct;
    cur.next_range_vs_atr = next.range_vs_atr;
  }

  // S4: bar scans that needed S3 parameters
  if (scanParams.length > 0) {
    await store.run(
      "CREATE OR REPLACE TEMP TABLE _p (trade_date DATE, prev_close DOUBLE, prev_high DOUBLE, prev_low DOUBLE, gap_dir VARCHAR)",
    );
    for (let i = 0; i < scanParams.length; i += 500) {
      const chunk = scanParams.slice(i, i + 500);
      const values = chunk
        .map(
          (p) =>
            `(DATE ${sqlStr(p.tradeDate)}, ${sqlNum(p.prevClose)}, ${sqlNum(p.prevHigh)}, ${sqlNum(p.prevLow)}, ${sqlStr(p.gapDir)})`,
        )
        .join(", ");
      await store.run(`INSERT INTO _p VALUES ${values}`);
    }
    const scanRows = await store.all(`
      SELECT CAST(p.trade_date AS VARCHAR) AS trade_date,
        min(b.ts) FILTER (WHERE p.gap_dir = 'up' AND b.low <= p.prev_close) AS fill_up_ts,
        min(b.ts) FILTER (WHERE p.gap_dir = 'down' AND b.high >= p.prev_close) AS fill_dn_ts,
        min(b.ts) FILTER (WHERE b.high >= p.prev_high) AS touch_ph_ts,
        min(b.ts) FILTER (WHERE b.low <= p.prev_low) AS touch_pl_ts
      FROM _p p JOIN _sess s USING (trade_date)
      JOIN bars b ON b.symbol = ${sym} AND b.tf = ${tf} AND b.ts >= s.start_ts AND b.ts < s.end_ts
      GROUP BY p.trade_date
    `);
    const scanByDate = new Map(scanRows.map((r) => [asStr(r.trade_date) ?? "", r]));
    for (const row of out) {
      const scan = scanByDate.get(row.trade_date as string);
      const startTs = row.start_ts as number;
      if (row.prev_high !== null && scan) {
        const touchPh = asNum(scan.touch_ph_ts);
        const touchPl = asNum(scan.touch_pl_ts);
        row.touched_prev_high = touchPh !== null;
        row.touch_prev_high_min = touchPh !== null ? Math.floor((touchPh - startTs) / 60000) : null;
        row.touched_prev_low = touchPl !== null;
        row.touch_prev_low_min = touchPl !== null ? Math.floor((touchPl - startTs) / 60000) : null;
      }
      const gapDir = row.gap_dir as string | null;
      if (gapDir === "up" || gapDir === "down") {
        const fillTs = scan ? asNum(gapDir === "up" ? scan.fill_up_ts : scan.fill_dn_ts) : null;
        row.gap_filled = fillTs !== null;
        row.gap_fill_min = fillTs !== null ? Math.floor((fillTs - startTs) / 60000) : null;
        const close = row.close as number;
        const prevClose = row.prev_close as number;
        row.gap_reversed =
          fillTs !== null && (gapDir === "up" ? close < prevClose : close > prevClose);
      } else if (gapDir === "none") {
        row.gap_filled = null;
        row.gap_fill_min = null;
        row.gap_reversed = null;
      }
    }
  }

  // Assemble + insert
  const cols = featureColumns(windows);
  const ndjsonPath = join(store.tmpDir, `features-${randomUUID()}.ndjson`);
  const lines = out.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const c of cols) obj[c.name] = row[c.name] ?? null;
    return JSON.stringify(obj);
  });
  writeFileSync(ndjsonPath, lines.join("\n"));
  try {
    const columnSpec = cols.map((c) => `'${c.name}': '${c.type}'`).join(", ");
    await store.run(
      `DELETE FROM session_features WHERE symbol = ${sym} AND session_key = ${sqlStr(sessionKey)}`,
    );
    if (out.length > 0) {
      await store.run(`
        INSERT INTO session_features BY NAME
        SELECT * FROM read_json(${sqlPath(ndjsonPath)}, format = 'newline_delimited',
                                columns = {${columnSpec}})
      `);
    }
  } finally {
    try {
      unlinkSync(ndjsonPath);
    } catch {
      // best effort
    }
  }
  await store.run(
    "DROP TABLE IF EXISTS _s1; DROP TABLE IF EXISTS _s2; DROP TABLE IF EXISTS _sess; DROP TABLE IF EXISTS _p",
  );
  log(`derived ${out.length} sessions for ${symbol.symbol} ${sessionKey}`);
  return out.length;
}
