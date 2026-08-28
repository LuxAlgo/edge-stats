/*
  Journal bridge: turns the user's own executed trades into journal event
  tags (TRADED, TRADED_WIN, TRADED_LOSS) stored as ordinary event files, so
  every report, predicate, and the eventOccurs outcome can condition on the
  user's real participation. Pure logic only: nothing in core talks to a
  broker. The CLI feeds this module normalized fills (from
  @luxalgo/broker-sdk or a statement CSV); the same functions back the MCP
  surface.

  Conventions, stated plainly because they decide what a "win day" means:
  - A fill belongs to the first session window that ENDS after it. That
    assigns pre-market fills to that day's session and overnight futures
    fills to the trade date the session settles on, with one rule.
  - Realized P&L uses signed FIFO per symbol: buys and sells both open
    lots; an opposite-side fill closes the oldest open lots first. A close
    realizes (exit - entry) * quantity * multiplier, net of both fills'
    proportional fees, on the CLOSING fill's trade date. Positions that
    never close realize nothing.
  - A day is TRADED_WIN when its realized total is > 0, TRADED_LOSS when
    < 0. A day with fills but no realizations (or exactly zero) is only
    TRADED.
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventFile } from "./events";
import { eventsDir, syncEventsIntoStore } from "./events";
import type { Store } from "./store/store";
import type { SessionWindow } from "./calendar/types";

/** One executed fill, already normalized. Mirrors the broker-sdk shape. */
export interface JournalFill {
  symbol: string;
  side: "buy" | "sell";
  /** Always positive; `side` carries the direction. */
  quantity: number;
  /** Price per unit in the account currency. */
  price: number;
  /** Commission/fee for this fill, in the account currency. */
  fee?: number;
  /** ISO 8601. Fills without a timestamp cannot be day-tagged. */
  executedAt?: string;
}

export const JOURNAL_EVENTS = ["TRADED", "TRADED_WIN", "TRADED_LOSS"] as const;
export type JournalEventName = (typeof JOURNAL_EVENTS)[number];

export interface JournalBuildOptions {
  fills: JournalFill[];
  /** Session windows per STORE symbol, ascending by endMs. */
  windowsBySymbol: Record<string, SessionWindow[]>;
  /** Broker symbol -> store symbol (e.g. ESU6 -> ES). Identity by default. */
  map?: Record<string, string>;
  /** Contract multiplier per store symbol (price points -> currency). */
  multipliers?: Record<string, number>;
  /** Where the fills came from, recorded in the event files' sources. */
  source: string;
  /** Import date (ISO), the coverage horizon end. Injectable for tests. */
  importedOn: string;
}

export interface JournalBuildResult {
  events: EventFile[];
  counts: {
    fills: number;
    tagged: number;
    skippedNoTimestamp: number;
    skippedNoSymbol: number;
    skippedOutOfRange: number;
    tradedDays: number;
    winDays: number;
    lossDays: number;
  };
  /** Store symbols that received at least one fill. */
  symbols: string[];
}

/**
 * The day-assignment rule: the first window that ends after the timestamp.
 * Windows must be sorted ascending by endMs. Returns null when the fill is
 * after every known window.
 */
export function assignTradeDate(tsMs: number, windows: SessionWindow[]): string | null {
  let lo = 0;
  let hi = windows.length - 1;
  let hit: SessionWindow | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = windows[mid];
    if (w === undefined) break;
    if (w.endMs > tsMs) {
      hit = w;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return hit?.tradeDate ?? null;
}

interface DatedFill extends JournalFill {
  storeSymbol: string;
  tradeDate: string;
  tsMs: number;
}

interface OpenLot {
  /** +1 long entry (a buy), -1 short entry (a sell). */
  dir: 1 | -1;
  qty: number;
  price: number;
  feePerUnit: number;
}

/**
 * Signed FIFO realization. Returns realized P&L per trade date, in account
 * currency, net of the matched fills' proportional fees.
 */
export function realizedPnlByDay(
  fills: DatedFill[],
  multipliers: Record<string, number>,
): Map<string, number> {
  const byDay = new Map<string, number>();
  const lots = new Map<string, OpenLot[]>();
  const sorted = [...fills].sort((a, b) => a.tsMs - b.tsMs);
  for (const f of sorted) {
    const mult = multipliers[f.storeSymbol] ?? 1;
    const dir: 1 | -1 = f.side === "buy" ? 1 : -1;
    const feePerUnit = f.quantity > 0 ? (f.fee ?? 0) / f.quantity : 0;
    let remaining = f.quantity;
    const queue = lots.get(f.storeSymbol) ?? [];
    while (remaining > 0 && queue.length > 0 && queue[0] !== undefined && queue[0].dir !== dir) {
      const lot = queue[0];
      const closed = Math.min(remaining, lot.qty);
      // Long entry closed by a sell: exit - entry. Short entry closed by a
      // buy: entry - exit. lot.dir carries the sign in one expression.
      const gross = (f.price - lot.price) * closed * lot.dir * mult;
      const net = gross - (lot.feePerUnit + feePerUnit) * closed;
      byDay.set(f.tradeDate, (byDay.get(f.tradeDate) ?? 0) + net);
      lot.qty -= closed;
      remaining -= closed;
      if (lot.qty === 0) queue.shift();
    }
    if (remaining > 0) {
      queue.push({ dir, qty: remaining, price: f.price, feePerUnit });
    }
    lots.set(f.storeSymbol, queue);
  }
  return byDay;
}

/** Build the journal event files from normalized fills. Pure. */
export function buildJournalEvents(opts: JournalBuildOptions): JournalBuildResult {
  const { fills, windowsBySymbol, map = {}, multipliers = {}, source, importedOn } = opts;
  const dated: DatedFill[] = [];
  let skippedNoTimestamp = 0;
  let skippedNoSymbol = 0;
  let skippedOutOfRange = 0;

  for (const fill of fills) {
    const storeSymbol = map[fill.symbol] ?? fill.symbol;
    const windows = windowsBySymbol[storeSymbol];
    if (windows === undefined) {
      skippedNoSymbol += 1;
      continue;
    }
    const tsMs = fill.executedAt === undefined ? Number.NaN : Date.parse(fill.executedAt);
    if (Number.isNaN(tsMs)) {
      skippedNoTimestamp += 1;
      continue;
    }
    const tradeDate = assignTradeDate(tsMs, windows);
    if (tradeDate === null) {
      skippedOutOfRange += 1;
      continue;
    }
    dated.push({ ...fill, storeSymbol, tradeDate, tsMs });
  }

  const tradedDates = [...new Set(dated.map((f) => f.tradeDate))].sort();
  const pnl = realizedPnlByDay(dated, multipliers);
  const winDates = [...pnl.entries()]
    .filter(([, v]) => v > 0)
    .map(([d]) => d)
    .sort();
  const lossDates = [...pnl.entries()]
    .filter(([, v]) => v < 0)
    .map(([d]) => d)
    .sort();

  const coverageFrom = tradedDates[0] ?? importedOn;
  const version = `journal-${importedOn}`;
  const file = (event: JournalEventName, dates: string[], doc: string): EventFile => ({
    event,
    version,
    sources: [source],
    notes: doc,
    coverage: { from: coverageFrom, to: importedOn },
    dates,
  });

  const events: EventFile[] = [
    file("TRADED", tradedDates, "Trade dates with at least one imported fill."),
    file(
      "TRADED_WIN",
      winDates,
      "Trade dates whose realized P&L (signed FIFO, fee-adjusted) was positive.",
    ),
    file(
      "TRADED_LOSS",
      lossDates,
      "Trade dates whose realized P&L (signed FIFO, fee-adjusted) was negative.",
    ),
  ];

  return {
    events,
    counts: {
      fills: fills.length,
      tagged: dated.length,
      skippedNoTimestamp,
      skippedNoSymbol,
      skippedOutOfRange,
      tradedDays: tradedDates.length,
      winDays: winDates.length,
      lossDays: lossDates.length,
    },
    symbols: [...new Set(dated.map((f) => f.storeSymbol))].sort(),
  };
}

/**
 * Write the journal event files into the store's events directory and
 * refresh the events table. Re-importing overwrites the previous journal.
 */
export async function writeJournalEvents(store: Store, events: EventFile[]): Promise<number> {
  const dir = eventsDir(store.dataDir);
  mkdirSync(dir, { recursive: true });
  for (const ev of events) {
    const path = join(dir, `journal-${ev.event.toLowerCase()}.json`);
    writeFileSync(path, `${JSON.stringify(ev, null, 2)}\n`);
  }
  return syncEventsIntoStore(store);
}

/** The journal events currently present in a store's events directory. */
export function journalEventsIn(files: EventFile[]): EventFile[] {
  const names = new Set<string>(JOURNAL_EVENTS);
  return files.filter((f) => names.has(f.event));
}
