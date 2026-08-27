import { sqlNum, sqlStr } from "../util/sql";
import type { PredicateDef } from "./types";
import { requireWindow } from "./types";

const DIRS = ["up", "down", "any"] as const;

function orCol(minutes: number, col: string): string {
  return `f.or${minutes}_${col}`;
}

export const predicates: PredicateDef[] = [
  {
    kind: "predicate",
    name: "gapUp",
    title: "Gapped up",
    doc: "The session opened above the prior session's close.",
    args: [],
    sql: () => "f.gap_dir = 'up'",
    library: [{ kind: "concept", slug: "gap-fill" }],
  },
  {
    kind: "predicate",
    name: "gapDown",
    title: "Gapped down",
    doc: "The session opened below the prior session's close.",
    args: [],
    sql: () => "f.gap_dir = 'down'",
  },
  {
    kind: "predicate",
    name: "noGap",
    title: "No gap",
    doc: "The session opened exactly at the prior session's close (or gap data is unavailable).",
    args: [],
    sql: () => "(f.gap_dir = 'none' OR f.gap_dir IS NULL)",
  },
  {
    kind: "predicate",
    name: "orbBroke",
    title: "Opening range broke",
    doc: "The session broke its opening range (first n minutes) in the given direction after the range formed.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 15m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break direction" },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_break")} = ${sqlStr(dir)}`;
    },
    examples: ["closeGreen WHERE orbBroke(15m, up)"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "predicate",
    name: "orbFalseBroke",
    title: "Opening range false break (condition)",
    doc: "The first opening-range break failed: price closed back inside the range (or beyond the opposite side). Condition form of the orbFalseBreak outcome.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 15m" },
      {
        name: "dir",
        type: "enum",
        values: DIRS,
        default: "any",
        doc: "Direction of the failed break",
      },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      const dirCond =
        dir === "any"
          ? `${orCol(w, "first_break")} IN ('up', 'down')`
          : `${orCol(w, "first_break")} = ${sqlStr(dir)}`;
      return `(${dirCond} AND ${orCol(w, "false_break")})`;
    },
  },
  {
    kind: "predicate",
    name: "orbBrokeBoth",
    title: "Opening range broke both sides",
    doc: "The session traded beyond both extremes of its opening range.",
    args: [{ name: "window", type: "duration", required: true, doc: "Opening-range window" }],
    sql: (a, ctx) => `${orCol(requireWindow(a.window as number, ctx), "broke_both")}`,
  },
  {
    kind: "predicate",
    name: "ibSingleBreak",
    title: "Initial balance single break",
    doc: "The session broke exactly one side of its initial balance.",
    args: [{ name: "dir", type: "enum", values: DIRS, default: "any", doc: "Which side broke" }],
    sql: (a) => {
      const dir = a.dir as string;
      if (dir === "any") return `f.ib_break IN ('single_up', 'single_down')`;
      return `f.ib_break = ${sqlStr(`single_${dir}`)}`;
    },
    library: [{ kind: "concept", slug: "initial-balance" }],
  },
  {
    kind: "predicate",
    name: "ibDoubleBreak",
    title: "Initial balance double break",
    doc: "The session broke both sides of its initial balance.",
    args: [],
    sql: () => `f.ib_break = 'double'`,
  },
  {
    kind: "predicate",
    name: "ibNoBreak",
    title: "Initial balance held",
    doc: "The session never traded beyond its initial balance.",
    args: [],
    sql: () => `f.ib_break = 'none'`,
  },
  {
    kind: "predicate",
    name: "eventDay",
    title: "Macro event day",
    doc: "The trade date is in the events calendar under the given name (e.g. 'FOMC', 'CPI', 'NFP', 'OPEX'). Event dates ship as versioned data files with cited sources.",
    args: [
      {
        name: "event",
        type: "string",
        required: true,
        doc: "Event name as listed in the events data",
      },
    ],
    sql: (a) =>
      `EXISTS (SELECT 1 FROM events e WHERE e.date = f.trade_date AND e.event = ${sqlStr(String(a.event))})`,
    examples: ["gapFill WHERE NOT eventDay('FOMC')"],
  },
  {
    kind: "predicate",
    name: "dayBeforeEvent",
    title: "Trading day before event",
    doc: "The NEXT trading session for this symbol is an event day: trading-calendar aware, not calendar-day arithmetic.",
    args: [{ name: "event", type: "string", required: true, doc: "Event name" }],
    sql: (a) =>
      `EXISTS (SELECT 1 FROM events e WHERE e.event = ${sqlStr(String(a.event))} AND e.date = (
        SELECT min(f2.trade_date) FROM session_features f2
        WHERE f2.symbol = f.symbol AND f2.session_key = f.session_key AND f2.trade_date > f.trade_date
      ))`,
  },
  {
    kind: "predicate",
    name: "dayAfterEvent",
    title: "Trading day after event",
    doc: "The PREVIOUS trading session for this symbol was an event day.",
    args: [{ name: "event", type: "string", required: true, doc: "Event name" }],
    sql: (a) =>
      `EXISTS (SELECT 1 FROM events e WHERE e.event = ${sqlStr(String(a.event))} AND e.date = (
        SELECT max(f2.trade_date) FROM session_features f2
        WHERE f2.symbol = f.symbol AND f2.session_key = f.session_key AND f2.trade_date < f.trade_date
      ))`,
  },
  {
    kind: "predicate",
    name: "streak",
    title: "Consecutive-session streak",
    doc: "At least n consecutive sessions of the given color ended immediately before this session.",
    args: [
      {
        name: "dir",
        type: "enum",
        values: ["green", "red"] as const,
        required: true,
        doc: "Streak color",
      },
      { name: "n", type: "number", required: true, doc: "Minimum streak length" },
    ],
    sql: (a) =>
      a.dir === "green"
        ? `f.prev_green_streak >= ${sqlNum(a.n as number)}`
        : `f.prev_red_streak >= ${sqlNum(a.n as number)}`,
    examples: ["closeGreen WHERE streak(red, 3)"],
    library: [{ kind: "indicator", slug: "session-streaks" }],
  },
  {
    kind: "predicate",
    name: "fvgPresent",
    title: "Unfilled fair value gap present",
    doc: "An unfilled session-level FVG sat entirely on the given side of the open at session start. Zones form on prior sessions only: no lookahead.",
    args: [
      {
        name: "ref",
        type: "enum",
        values: ["open"] as const,
        default: "open",
        doc: "Reference price (v0.1: the session open)",
      },
      {
        name: "side",
        type: "enum",
        values: ["above", "below"] as const,
        required: true,
        doc: "Side of the reference",
      },
    ],
    sql: (a) => (a.side === "above" ? "f.fvg_above" : "f.fvg_below"),
    examples: ["gapFill WHERE fvgPresent(open, below) AND dayOfWeek = Tue"],
    library: [{ kind: "indicator", slug: "fvg-sessions" }],
  },
];
