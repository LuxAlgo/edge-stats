/*
  Session resolution: turn (symbol, session key, date range) into concrete
  UTC windows, holiday- and DST-aware. All wall-clock times are interpreted
  in the session's IANA timezone via luxon, so DST transitions fall out of
  the timezone database instead of hand-rolled offsets.

  Conventions:
  - A session belongs to a *trade date*. Overnight sessions (CME Globex
    18:00 → 17:00 ET) open on the calendar day before their trade date —
    Monday's Globex session starts Sunday evening.
  - Half days truncate the session end to the exchange's published early
    close for that date.
  - Holidays remove the trade date entirely. The engine takes no position
    on partial holiday sessions; if an exchange trades a shortened schedule
    it belongs in the half-day list.
*/
import { DateTime } from "luxon";
import type { SessionDef, SymbolConfig } from "../config";
import { defaultExchange } from "../config";
import type { HolidayCalendar, SessionWindow } from "./types";

export function builtinSessionDefs(symbol: SymbolConfig): Record<string, SessionDef> {
  const exchange = defaultExchange(symbol);
  switch (exchange) {
    case "NYSE":
      return {
        rth: { start: "09:30", end: "16:00", tz: "America/New_York", overnight: false },
      };
    case "CME":
      return {
        rth: { start: "09:30", end: "16:00", tz: "America/New_York", overnight: false },
        globex: { start: "18:00", end: "17:00", tz: "America/New_York", overnight: true },
      };
    case "CRYPTO":
      return {
        utc: { start: "00:00", end: "24:00", tz: "UTC", overnight: false },
        ny: { start: "09:30", end: "16:00", tz: "America/New_York", overnight: false },
      };
    case "FX":
      return {
        sydney: { start: "21:00", end: "06:00", tz: "UTC", overnight: true },
        tokyo: { start: "00:00", end: "09:00", tz: "UTC", overnight: false },
        london: { start: "07:00", end: "16:00", tz: "UTC", overnight: false },
        newyork: { start: "12:00", end: "21:00", tz: "UTC", overnight: false },
      };
  }
}

export function sessionDefsFor(symbol: SymbolConfig): Record<string, SessionDef> {
  return { ...builtinSessionDefs(symbol), ...(symbol.sessions ?? {}) };
}

function parseHHMM(s: string): { hour: number; minute: number } {
  const hour = Number(s.slice(0, 2));
  const minute = Number(s.slice(3, 5));
  return { hour, minute };
}

/** A wall-clock time on a calendar date in a timezone → UTC ms. '24:00' rolls to next midnight. */
function zonedMs(isoDate: string, hhmm: string, tz: string): number {
  const { hour, minute } = parseHHMM(hhmm);
  const base = DateTime.fromISO(isoDate, { zone: tz });
  if (!base.isValid) throw new Error(`invalid date/zone: ${isoDate} ${tz}`);
  if (hour === 24) return base.plus({ days: 1 }).startOf("day").toMillis();
  return base.set({ hour, minute, second: 0, millisecond: 0 }).toMillis();
}

export interface ResolveSessionsOptions {
  symbol: SymbolConfig;
  sessionKey: string;
  /** Trade dates, inclusive, ISO. */
  from: string;
  to: string;
  holidays: HolidayCalendar | null;
}

export function resolveSessions(opts: ResolveSessionsOptions): SessionWindow[] {
  const { symbol, sessionKey, from, to, holidays } = opts;
  const defs = sessionDefsFor(symbol);
  const def = defs[sessionKey];
  if (!def) {
    throw new Error(
      `unknown session '${sessionKey}' for ${symbol.symbol} — available: ${Object.keys(defs).join(", ")}`,
    );
  }
  const weekendsTrade = symbol.assetClass === "crypto";
  const holidayByDate = new Map((holidays?.holidays ?? []).map((h) => [h.date, h.name]));
  const halfDayByDate = new Map((holidays?.halfDays ?? []).map((h) => [h.date, h]));

  const windows: SessionWindow[] = [];
  let cursor = DateTime.fromISO(from, { zone: "utc" });
  const end = DateTime.fromISO(to, { zone: "utc" });
  if (!cursor.isValid || !end.isValid) throw new Error(`invalid date range ${from}..${to}`);

  for (; cursor <= end; cursor = cursor.plus({ days: 1 })) {
    const tradeDate = cursor.toISODate();
    if (tradeDate === null) continue;
    const weekday = cursor.weekday; // 1 = Monday … 7 = Sunday (of the trade date)
    if (!weekendsTrade && weekday > 5) continue;
    if (holidayByDate.has(tradeDate)) continue;

    const startDate = def.overnight ? cursor.minus({ days: 1 }).toISODate() : tradeDate;
    if (startDate === null) continue;
    const startMs = zonedMs(startDate, def.start, def.tz);
    let endMs = zonedMs(tradeDate, def.end, def.tz);

    const half = halfDayByDate.get(tradeDate);
    if (half) {
      const earlyMs = zonedMs(tradeDate, half.close, def.tz);
      if (earlyMs < endMs) endMs = earlyMs;
    }

    if (endMs <= startMs) continue;
    windows.push({
      symbol: symbol.symbol,
      sessionKey,
      tradeDate,
      startMs,
      endMs,
      isHalfDay: half !== undefined,
    });
  }
  return windows;
}

/** The session keys features are derived for: every defined window. */
export function derivableSessionKeys(symbol: SymbolConfig): string[] {
  return Object.keys(sessionDefsFor(symbol));
}
