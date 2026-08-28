import { describe, expect, it } from "vitest";
import type { SessionWindow } from "../src/calendar/types";
import type { JournalFill } from "../src/journal";
import { assignTradeDate, buildJournalEvents, realizedPnlByDay } from "../src/journal";
import { compileQuery } from "../src/query/compile";
import { astToDsl } from "../src/query/normalize";
import { parseDsl } from "../src/query/parser";

const ms = (iso: string) => Date.parse(iso);

/*
  Hand-built overnight windows in the futures convention: the session that
  settles on Monday opens Sunday 23:00 UTC and ends Monday 22:00 UTC.
*/
const win = (tradeDate: string, startIso: string, endIso: string): SessionWindow => ({
  symbol: "ES",
  sessionKey: "globex",
  tradeDate,
  startMs: ms(startIso),
  endMs: ms(endIso),
  isHalfDay: false,
});

const ES_WINDOWS: SessionWindow[] = [
  win("2026-03-02", "2026-03-01T23:00:00Z", "2026-03-02T22:00:00Z"),
  win("2026-03-03", "2026-03-02T23:00:00Z", "2026-03-03T22:00:00Z"),
  win("2026-03-04", "2026-03-03T23:00:00Z", "2026-03-04T22:00:00Z"),
];

const fill = (over: Partial<JournalFill>): JournalFill => ({
  symbol: "ES",
  side: "buy",
  quantity: 1,
  price: 100,
  ...over,
});

describe("journal day assignment (a fill belongs to the first session that ends after it)", () => {
  it("puts a Sunday-evening overnight fill on Monday's trade date", () => {
    expect(assignTradeDate(ms("2026-03-01T23:30:00Z"), ES_WINDOWS)).toBe("2026-03-02");
  });

  it("puts a fill in the maintenance gap between sessions on the upcoming trade date", () => {
    expect(assignTradeDate(ms("2026-03-02T22:30:00Z"), ES_WINDOWS)).toBe("2026-03-03");
  });

  it("cannot place a fill after every known session", () => {
    expect(assignTradeDate(ms("2026-03-04T22:00:00Z"), ES_WINDOWS)).toBeNull();
  });
});

describe("journal realized P&L (signed FIFO, fee-adjusted, realized on the closing day)", () => {
  const dated = (
    over: Partial<JournalFill> & { executedAt: string },
  ): JournalFill & { storeSymbol: string; tradeDate: string; tsMs: number } => {
    const f = fill(over);
    const tradeDate = assignTradeDate(ms(over.executedAt), ES_WINDOWS);
    if (tradeDate === null) throw new Error("fixture fill out of range");
    return { ...f, storeSymbol: "ES", tradeDate, tsMs: ms(over.executedAt) };
  };

  it("a long round trip nets price gain times quantity minus both fills' fees", () => {
    const pnl = realizedPnlByDay(
      [
        dated({ side: "buy", quantity: 2, price: 100, fee: 2, executedAt: "2026-03-02T10:00:00Z" }),
        dated({
          side: "sell",
          quantity: 2,
          price: 105,
          fee: 2,
          executedAt: "2026-03-02T15:00:00Z",
        }),
      ],
      {},
    );
    // (105 - 100) * 2 = 10 gross, minus (1 + 1) per-unit fees * 2 = 4.
    expect(pnl.get("2026-03-02")).toBeCloseTo(6, 10);
  });

  it("a short sale closed by a buy realizes profit when price fell", () => {
    const pnl = realizedPnlByDay(
      [
        dated({ side: "sell", quantity: 1, price: 50, executedAt: "2026-03-02T10:00:00Z" }),
        dated({ side: "buy", quantity: 1, price: 45, executedAt: "2026-03-02T15:00:00Z" }),
      ],
      {},
    );
    expect(pnl.get("2026-03-02")).toBeCloseTo(5, 10);
  });

  it("partial closes realize FIFO on each closing fill's own trade date", () => {
    const pnl = realizedPnlByDay(
      [
        dated({ side: "buy", quantity: 3, price: 10, executedAt: "2026-03-02T10:00:00Z" }),
        dated({ side: "sell", quantity: 1, price: 12, executedAt: "2026-03-03T10:00:00Z" }),
        dated({ side: "sell", quantity: 2, price: 9, executedAt: "2026-03-04T10:00:00Z" }),
      ],
      {},
    );
    expect(pnl.get("2026-03-03")).toBeCloseTo(2, 10);
    expect(pnl.get("2026-03-04")).toBeCloseTo(-2, 10);
  });

  it("the contract multiplier scales magnitude so it can decide a mixed day's sign", () => {
    const pnl = realizedPnlByDay(
      [
        dated({
          symbol: "ES",
          side: "buy",
          quantity: 1,
          price: 10,
          executedAt: "2026-03-02T10:00:00Z",
        }),
        dated({
          symbol: "ES",
          side: "sell",
          quantity: 1,
          price: 11,
          executedAt: "2026-03-02T11:00:00Z",
        }),
      ],
      { ES: 50 },
    );
    expect(pnl.get("2026-03-02")).toBeCloseTo(50, 10);
  });

  it("a position that never closes realizes nothing", () => {
    const pnl = realizedPnlByDay(
      [dated({ side: "buy", quantity: 5, price: 10, executedAt: "2026-03-02T10:00:00Z" })],
      {},
    );
    expect(pnl.size).toBe(0);
  });
});

describe("journal event files", () => {
  it("tags traded, win, and loss days and reports every skip honestly", () => {
    const result = buildJournalEvents({
      fills: [
        // Day 1: a winning round trip.
        fill({ side: "buy", quantity: 1, price: 100, executedAt: "2026-03-02T10:00:00Z" }),
        fill({ side: "sell", quantity: 1, price: 104, executedAt: "2026-03-02T15:00:00Z" }),
        // Day 2: a losing round trip on a mapped contract symbol.
        fill({
          symbol: "ESU6",
          side: "buy",
          quantity: 1,
          price: 100,
          executedAt: "2026-03-03T10:00:00Z",
        }),
        fill({
          symbol: "ESU6",
          side: "sell",
          quantity: 1,
          price: 98,
          executedAt: "2026-03-03T15:00:00Z",
        }),
        // Day 3: an open-only day (traded, neither win nor loss).
        fill({ side: "buy", quantity: 1, price: 100, executedAt: "2026-03-04T10:00:00Z" }),
        // Skips: no timestamp, unknown symbol, after the last window.
        fill({}),
        fill({ symbol: "UNKNOWN", executedAt: "2026-03-02T10:00:00Z" }),
        fill({ executedAt: "2026-03-09T10:00:00Z" }),
      ],
      windowsBySymbol: { ES: ES_WINDOWS },
      map: { ESU6: "ES" },
      source: "test fixture",
      importedOn: "2026-03-05",
    });

    expect(result.counts).toEqual({
      fills: 8,
      tagged: 5,
      skippedNoTimestamp: 1,
      skippedNoSymbol: 1,
      skippedOutOfRange: 1,
      tradedDays: 3,
      winDays: 1,
      lossDays: 1,
    });
    expect(result.symbols).toEqual(["ES"]);

    const byName = new Map(result.events.map((e) => [e.event, e]));
    expect(byName.get("TRADED")?.dates).toEqual(["2026-03-02", "2026-03-03", "2026-03-04"]);
    expect(byName.get("TRADED_WIN")?.dates).toEqual(["2026-03-02"]);
    expect(byName.get("TRADED_LOSS")?.dates).toEqual(["2026-03-03"]);
    for (const ev of result.events) {
      expect(ev.coverage).toEqual({ from: "2026-03-02", to: "2026-03-05" });
      expect(ev.version).toBe("journal-2026-03-05");
      expect(ev.sources).toEqual(["test fixture"]);
    }
  });
});

describe("the eventOccurs outcome", () => {
  const ctx = { orWindows: [5, 15, 30, 60], ibWindow: 60 };

  it("round-trips through the DSL with a journal condition", () => {
    const dsl = "eventOccurs('TRADED_WIN') WHERE eventDay('TRADED')";
    const ast = parseDsl(dsl);
    expect(astToDsl(parseDsl(astToDsl(ast)))).toBe(astToDsl(ast));
  });

  it("compiles to an events-table membership test with every session eligible", () => {
    const compiled = compileQuery(parseDsl("eventOccurs('FOMC')"), ctx);
    expect(compiled.eligibilitySql).toBe("TRUE");
    expect(compiled.successSql).toContain("e.event = 'FOMC'");
    expect(compiled.successSql).toContain("e.date = f.trade_date");
  });
});
