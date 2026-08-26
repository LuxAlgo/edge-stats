export interface SessionWindow {
  symbol: string;
  sessionKey: string;
  /** Exchange trade date (ISO). For overnight sessions this is the date the session settles on. */
  tradeDate: string;
  /** UTC epoch milliseconds, inclusive. */
  startMs: number;
  /** UTC epoch milliseconds, exclusive. */
  endMs: number;
  isHalfDay: boolean;
  holiday?: string;
}

export interface HolidayEntry {
  date: string;
  name: string;
}

export interface HalfDayEntry {
  date: string;
  name: string;
  /** Early close, exchange-local wall clock (HH:MM). */
  close: string;
}

export interface HolidayCalendar {
  exchange: string;
  version: string;
  sources: string[];
  notes?: string;
  /** Dates outside this range are NOT covered — the freshness check reds when the horizon nears. */
  coverage: { from: string; to: string };
  holidays: HolidayEntry[];
  halfDays: HalfDayEntry[];
}
