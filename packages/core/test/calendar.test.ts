/*
  Calendar edge cases as first-class tests: DST transitions, holidays,
  half days, overnight sessions, 24/7 crypto weeks. A wrong holiday beats
  no feature — these are the cases where session-stats clones die.
*/
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { holidayCalendarSchema } from "../src/calendar/data";
import { resolveSessions } from "../src/calendar/sessions";
import type { SymbolConfig } from "../src/config";
import { symbolConfigSchema } from "../src/config";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const nyse = holidayCalendarSchema.parse(
  JSON.parse(readFileSync(join(repoRoot, "data", "holidays", "nyse.json"), "utf8")),
);
const cme = holidayCalendarSchema.parse(
  JSON.parse(readFileSync(join(repoRoot, "data", "holidays", "cme.json"), "utf8")),
);

function sym(
  partial: Partial<SymbolConfig> & { symbol: string; assetClass: SymbolConfig["assetClass"] },
): SymbolConfig {
  return symbolConfigSchema.parse({ adapter: "csv", ...partial });
}

const equity = sym({ symbol: "TEST_STK", assetClass: "equity" });
const future = sym({ symbol: "TEST_FUT", assetClass: "future" });
const crypto = sym({ symbol: "TEST_BTC", assetClass: "crypto" });
const fx = sym({ symbol: "TEST_FX", assetClass: "forex" });

const utcMs = (iso: string) => Date.parse(iso);

describe("NYSE RTH sessions", () => {
  it("shifts UTC boundaries across the 2024 spring-forward transition", () => {
    const windows = resolveSessions({
      symbol: equity,
      sessionKey: "rth",
      from: "2024-03-07",
      to: "2024-03-12",
      holidays: nyse,
    });
    const byDate = new Map(windows.map((w) => [w.tradeDate, w]));
    // EST before the transition: 09:30 ET = 14:30 UTC
    expect(byDate.get("2024-03-08")?.startMs).toBe(utcMs("2024-03-08T14:30:00Z"));
    // EDT after (DST began 2024-03-10): 09:30 ET = 13:30 UTC
    expect(byDate.get("2024-03-11")?.startMs).toBe(utcMs("2024-03-11T13:30:00Z"));
    expect(byDate.get("2024-03-11")?.endMs).toBe(utcMs("2024-03-11T20:00:00Z"));
    // no weekend sessions
    expect(byDate.has("2024-03-09")).toBe(false);
    expect(byDate.has("2024-03-10")).toBe(false);
  });

  it("shifts back across the 2024 fall-back transition", () => {
    const windows = resolveSessions({
      symbol: equity,
      sessionKey: "rth",
      from: "2024-11-01",
      to: "2024-11-04",
      holidays: nyse,
    });
    const byDate = new Map(windows.map((w) => [w.tradeDate, w]));
    expect(byDate.get("2024-11-01")?.startMs).toBe(utcMs("2024-11-01T13:30:00Z"));
    expect(byDate.get("2024-11-04")?.startMs).toBe(utcMs("2024-11-04T14:30:00Z"));
  });

  it("skips MLK 2024 and truncates the Thanksgiving half day", () => {
    const jan = resolveSessions({
      symbol: equity,
      sessionKey: "rth",
      from: "2024-01-08",
      to: "2024-01-19",
      holidays: nyse,
    });
    expect(jan).toHaveLength(9);
    expect(jan.some((w) => w.tradeDate === "2024-01-15")).toBe(false);

    const nov = resolveSessions({
      symbol: equity,
      sessionKey: "rth",
      from: "2024-11-27",
      to: "2024-11-29",
      holidays: nyse,
    });
    const byDate = new Map(nov.map((w) => [w.tradeDate, w]));
    expect(byDate.has("2024-11-28")).toBe(false); // Thanksgiving
    const half = byDate.get("2024-11-29");
    expect(half?.isHalfDay).toBe(true);
    expect(half?.endMs).toBe(utcMs("2024-11-29T18:00:00Z")); // 13:00 EST
  });
});

describe("CME Globex sessions", () => {
  it("opens Sunday evening for the Monday trade date, DST-aware", () => {
    const windows = resolveSessions({
      symbol: future,
      sessionKey: "globex",
      from: "2024-03-07",
      to: "2024-03-12",
      holidays: cme,
    });
    const byDate = new Map(windows.map((w) => [w.tradeDate, w]));
    // pre-DST: 18:00 EST = 23:00 UTC; 17:00 EST close = 22:00 UTC
    expect(byDate.get("2024-03-08")?.startMs).toBe(utcMs("2024-03-07T23:00:00Z"));
    expect(byDate.get("2024-03-08")?.endMs).toBe(utcMs("2024-03-08T22:00:00Z"));
    // Monday's session opens SUNDAY 18:00, already EDT: 22:00 UTC
    expect(byDate.get("2024-03-11")?.startMs).toBe(utcMs("2024-03-10T22:00:00Z"));
    expect(byDate.get("2024-03-11")?.endMs).toBe(utcMs("2024-03-11T21:00:00Z"));
  });

  it("closes Globex early on the Thanksgiving half day", () => {
    const windows = resolveSessions({
      symbol: future,
      sessionKey: "globex",
      from: "2024-11-28",
      to: "2024-11-28",
      holidays: cme,
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.isHalfDay).toBe(true);
    expect(windows[0]?.startMs).toBe(utcMs("2024-11-27T23:00:00Z"));
    expect(windows[0]?.endMs).toBe(utcMs("2024-11-28T18:00:00Z")); // 13:00 EST halt
  });

  it("has no session on Good Friday", () => {
    const windows = resolveSessions({
      symbol: future,
      sessionKey: "globex",
      from: "2024-03-29",
      to: "2024-03-29",
      holidays: cme,
    });
    expect(windows).toHaveLength(0);
  });
});

describe("24/7 and FX sessions", () => {
  it("crypto UTC day sessions include weekends and honor 24:00", () => {
    const windows = resolveSessions({
      symbol: crypto,
      sessionKey: "utc",
      from: "2024-03-04",
      to: "2024-03-10",
      holidays: null,
    });
    expect(windows).toHaveLength(7);
    const sat = windows.find((w) => w.tradeDate === "2024-03-09");
    expect(sat?.startMs).toBe(utcMs("2024-03-09T00:00:00Z"));
    expect(sat?.endMs).toBe(utcMs("2024-03-10T00:00:00Z"));
  });

  it("FX Sydney is an overnight UTC window", () => {
    const windows = resolveSessions({
      symbol: fx,
      sessionKey: "sydney",
      from: "2024-03-05",
      to: "2024-03-05",
      holidays: null,
    });
    expect(windows[0]?.startMs).toBe(utcMs("2024-03-04T21:00:00Z"));
    expect(windows[0]?.endMs).toBe(utcMs("2024-03-05T06:00:00Z"));
  });

  it("rejects unknown session keys with the available list", () => {
    expect(() =>
      resolveSessions({
        symbol: equity,
        sessionKey: "globex",
        from: "2024-01-02",
        to: "2024-01-02",
        holidays: nyse,
      }),
    ).toThrow(/available: rth/);
  });
});
