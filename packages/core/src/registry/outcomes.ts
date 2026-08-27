import { sqlNum } from "../util/sql";
import { fields } from "./fields";
import type { OutcomeDef } from "./types";
import { QueryError, requireWindow } from "./types";

const DIRS = ["up", "down", "any"] as const;

function orCol(minutes: number, col: string): string {
  return `f.or${minutes}_${col}`;
}

const numericFieldNames = fields.filter((f) => f.valueType === "number").map((f) => f.name);

function numericFieldSql(name: string): string {
  const def = fields.find((f) => f.name === name && f.valueType === "number");
  if (!def) {
    throw new QueryError(
      `hit() needs a numeric field, got '${name}'`,
      `numeric fields: ${numericFieldNames.join(", ")}`,
    );
  }
  return def.sql;
}

const CMPS: Record<string, string> = { gte: ">=", gt: ">", lte: "<=", lt: "<" };

export const outcomes: OutcomeDef[] = [
  {
    kind: "outcome",
    name: "gapFill",
    title: "Gap fill",
    doc: "Of the sessions that opened with a gap, how often price traded back to the prior session's close. Roll days are excluded by construction: a gap across a futures roll is a roll, not a gap.",
    args: [],
    eligibility: () => `f.gap_dir IN ('up', 'down')`,
    success: () => "f.gap_filled",
    value: {
      sql: () => "f.gap_fill_min",
      unit: "minutes",
      doc: "Minutes from the open to the fill, among filled sessions.",
    },
    examples: [
      "gapFill",
      "gapFill WHERE gapPct BETWEEN 0.2% AND 0.6% AND dayOfWeek = Tue",
      "gapFill WHERE fvgPresent(open, below) AND NOT eventDay('FOMC')",
    ],
    library: [
      { kind: "concept", slug: "gap-fill" },
      { kind: "indicator", slug: "session-gap-fill" },
    ],
  },
  {
    kind: "outcome",
    name: "gapHold",
    title: "Gap holds (gap-and-go)",
    doc: "Of the sessions that opened with a gap, how often the gap NEVER filled and the session closed beyond its open in the gap's direction: the gap-and-go continuation, measured directly instead of as the complement of the fill rate.",
    args: [
      {
        name: "dir",
        type: "enum",
        values: ["up", "down", "any"] as const,
        default: "any",
        doc: "Gap direction to count",
      },
    ],
    eligibility: (a) => {
      const dir = a.dir as string;
      if (dir === "any") return `f.gap_dir IN ('up', 'down')`;
      return `f.gap_dir = '${dir}'`;
    },
    success: () =>
      `(NOT coalesce(f.gap_filled, FALSE) AND ((f.gap_dir = 'up' AND f.green) OR (f.gap_dir = 'down' AND f.close < f.open)))`,
    examples: ["gapHold", "gapHold(up) WHERE gapBucket = l"],
    library: [
      { kind: "concept", slug: "gap-and-go" },
      { kind: "concept", slug: "gap-fill" },
    ],
  },
  {
    kind: "outcome",
    name: "gapReversal",
    title: "Reversal after gap fill",
    doc: "Of the sessions that filled their opening gap, how often the session then closed beyond the prior close against the gap's direction (fill-and-reverse).",
    args: [],
    eligibility: () => `f.gap_filled`,
    success: () => "f.gap_reversed",
    library: [
      { kind: "concept", slug: "gap-fill" },
      { kind: "indicator", slug: "session-gap-fill" },
    ],
  },
  {
    kind: "outcome",
    name: "closeGreen",
    title: "Session closes green",
    doc: "How often the session closed above its open, under whatever conditions you compose.",
    args: [],
    eligibility: () => "TRUE",
    success: () => "f.green",
    value: {
      sql: () => "f.ret_oc_pct",
      unit: "%",
      doc: "Open→close return distribution across eligible sessions.",
    },
    examples: ["closeGreen WHERE streak(red, 3)", "closeGreen WHERE insideDay"],
    library: [{ kind: "concept", slug: "session-open-close-behaviors" }],
  },
  {
    kind: "outcome",
    name: "nextCloseGreen",
    title: "Next session closes green",
    doc: "How often the NEXT session closed green given today's conditions: the day-after family of questions as one outcome.",
    args: [],
    eligibility: () => "f.next_green IS NOT NULL",
    success: () => "f.next_green",
    value: {
      sql: () => "f.next_ret_oc_pct",
      unit: "%",
      doc: "Next session's open→close return distribution.",
    },
    examples: ["nextCloseGreen WHERE insideDay", "nextCloseGreen WHERE nr7"],
  },
  {
    kind: "outcome",
    name: "orbBreak",
    title: "Opening range break",
    doc: "Of the sessions with a formed opening range, how often the range broke in the given direction.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 15m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break direction to count" },
    ],
    eligibility: (a, ctx) => `${orCol(requireWindow(a.window as number, ctx), "high")} IS NOT NULL`,
    success: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_break")} = '${dir}'`;
    },
    value: {
      sql: (a, ctx) => orCol(requireWindow(a.window as number, ctx), "break_min"),
      unit: "minutes",
      doc: "Minutes from the open to the first break, among breaking sessions.",
    },
    examples: ["orbBreak(15m, up)", "orbBreak(30m) WHERE gapUp"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "orbFalseBreak",
    title: "Opening range false break",
    doc: "Of the sessions whose opening range first broke in the given direction, how often that break failed (closed back inside the range or beyond the opposite side).",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window" },
      {
        name: "dir",
        type: "enum",
        values: DIRS,
        default: "any",
        doc: "Direction of the first break",
      },
    ],
    eligibility: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_break")} = '${dir}'`;
    },
    success: (a, ctx) => `${orCol(requireWindow(a.window as number, ctx), "false_break")}`,
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "orbTargetHit",
    title: "Opening range extension target hit",
    doc: "Of the sessions whose opening range first broke in the given direction, how often price extended at least r × the range beyond the broken side. Run a ladder of r values for target hit-rates.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window" },
      {
        name: "r",
        type: "number",
        required: true,
        doc: "Extension target in range multiples (e.g. 1 = one full range beyond the break)",
      },
      {
        name: "dir",
        type: "enum",
        values: DIRS,
        default: "any",
        doc: "Direction of the first break",
      },
    ],
    eligibility: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_break")} = '${dir}'`;
    },
    success: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const r = sqlNum(a.r as number);
      return `(CASE ${orCol(w, "first_break")}
        WHEN 'up' THEN ${orCol(w, "ext_up_r")} >= ${r}
        WHEN 'down' THEN ${orCol(w, "ext_dn_r")} >= ${r}
        ELSE FALSE END)`;
    },
    value: {
      sql: (a, ctx) => {
        const w = requireWindow(a.window as number, ctx);
        return `(CASE ${orCol(w, "first_break")}
          WHEN 'up' THEN ${orCol(w, "ext_up_r")}
          WHEN 'down' THEN ${orCol(w, "ext_dn_r")}
          ELSE NULL END)`;
      },
      unit: "r",
      doc: "Extension beyond the broken side, in range multiples.",
    },
    examples: ["orbTargetHit(15m, 1)", "orbTargetHit(30m, 2, up)"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "ibExtension",
    title: "Initial balance extension",
    doc: "Of the sessions that broke their initial balance in the given direction, how often price extended at least r × the IB range beyond the broken side.",
    args: [
      { name: "r", type: "number", required: true, doc: "Extension target in IB-range multiples" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break side" },
    ],
    eligibility: (a) => {
      const dir = a.dir as string;
      if (dir === "any") return `f.ib_break <> 'none' AND f.ib_break IS NOT NULL`;
      return `f.ib_break IN ('single_${dir}', 'double')`;
    },
    success: (a, ctx) => {
      const w = ctx.ibWindow;
      const r = sqlNum(a.r as number);
      const dir = a.dir as string;
      if (dir === "up") return `coalesce(${orCol(w, "ext_up_r")}, 0) >= ${r}`;
      if (dir === "down") return `coalesce(${orCol(w, "ext_dn_r")}, 0) >= ${r}`;
      return `(coalesce(${orCol(w, "ext_up_r")}, 0) >= ${r} OR coalesce(${orCol(w, "ext_dn_r")}, 0) >= ${r})`;
    },
    library: [
      { kind: "concept", slug: "initial-balance" },
      { kind: "indicator", slug: "initial-balance-breakout-signals" },
    ],
  },
  {
    kind: "outcome",
    name: "touchPrevHigh",
    title: "Touches prior high",
    doc: "How often the session traded at or above the prior session's high.",
    args: [],
    eligibility: () => "f.prev_high IS NOT NULL",
    success: () => "f.touched_prev_high",
    value: {
      sql: () => "f.touch_prev_high_min",
      unit: "minutes",
      doc: "Minutes from the open to the touch, among touching sessions.",
    },
    examples: ["touchPrevHigh WHERE openPosInPrevRange >= 0.5"],
    library: [{ kind: "indicator", slug: "session-levels-predictor" }],
  },
  {
    kind: "outcome",
    name: "touchPrevLow",
    title: "Touches prior low",
    doc: "How often the session traded at or below the prior session's low.",
    args: [],
    eligibility: () => "f.prev_low IS NOT NULL",
    success: () => "f.touched_prev_low",
    value: {
      sql: () => "f.touch_prev_low_min",
      unit: "minutes",
      doc: "Minutes from the open to the touch, among touching sessions.",
    },
    library: [{ kind: "indicator", slug: "session-levels-predictor" }],
  },
  {
    kind: "outcome",
    name: "breakHoldPrevHigh",
    title: "Breaks and holds prior high",
    doc: "Of the sessions that touched the prior high, how often they also closed above it.",
    args: [],
    eligibility: () => "f.touched_prev_high",
    success: () => "f.closed_above_prev_high",
    library: [{ kind: "indicator", slug: "session-levels-predictor" }],
  },
  {
    kind: "outcome",
    name: "breakHoldPrevLow",
    title: "Breaks and holds prior low",
    doc: "Of the sessions that touched the prior low, how often they also closed below it.",
    args: [],
    eligibility: () => "f.touched_prev_low",
    success: () => "f.closed_below_prev_low",
  },
  {
    kind: "outcome",
    name: "timeOfHighBefore",
    title: "Session high prints early",
    doc: "How often the session high printed within the first m minutes. The value distribution is the full time-of-high profile.",
    args: [
      { name: "within", type: "duration", required: true, doc: "Window from the open, e.g. 60m" },
    ],
    eligibility: () => "f.high_time_min IS NOT NULL",
    success: (a) => `f.high_time_min < ${sqlNum(a.within as number)}`,
    value: {
      sql: () => "f.high_time_min",
      unit: "minutes",
      doc: "Minutes from the open to the session high, across eligible sessions.",
    },
    library: [{ kind: "concept", slug: "session-high-low-statistics" }],
  },
  {
    kind: "outcome",
    name: "timeOfLowBefore",
    title: "Session low prints early",
    doc: "How often the session low printed within the first m minutes. The value distribution is the full time-of-low profile.",
    args: [{ name: "within", type: "duration", required: true, doc: "Window from the open" }],
    eligibility: () => "f.low_time_min IS NOT NULL",
    success: (a) => `f.low_time_min < ${sqlNum(a.within as number)}`,
    value: {
      sql: () => "f.low_time_min",
      unit: "minutes",
      doc: "Minutes from the open to the session low, across eligible sessions.",
    },
    library: [{ kind: "concept", slug: "session-high-low-statistics" }],
  },
  {
    kind: "outcome",
    name: "hit",
    title: "Threshold hit (generic)",
    doc: "The escape hatch: P(field ⋈ value) for any numeric field in the registry. Composable with any conditions: if the stat you want is not a named outcome, it is probably one hit() away.",
    args: [
      {
        name: "field",
        type: "string",
        required: true,
        doc: `Numeric field name (${numericFieldNames.slice(0, 6).join(", ")}, …)`,
      },
      {
        name: "cmp",
        type: "enum",
        values: ["gte", "gt", "lte", "lt"] as const,
        required: true,
        doc: "Comparison",
      },
      { name: "value", type: "number", required: true, doc: "Threshold" },
    ],
    eligibility: (a) => `${numericFieldSql(String(a.field))} IS NOT NULL`,
    success: (a) => {
      const cmp = CMPS[String(a.cmp)];
      if (!cmp) throw new QueryError(`unknown comparison '${String(a.cmp)}'`);
      return `${numericFieldSql(String(a.field))} ${cmp} ${sqlNum(a.value as number)}`;
    },
    value: {
      sql: (a) => numericFieldSql(String(a.field)),
      unit: "field",
      doc: "Distribution of the field itself across eligible sessions.",
    },
    examples: ["hit(retOcPct, gte, 0.5) WHERE gapUp", "hit(rangeVsAtr, gte, 1.5) WHERE nr7"],
  },
];
