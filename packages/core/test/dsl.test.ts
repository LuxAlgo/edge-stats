import { describe, expect, it } from "vitest";
import { compileQuery, suggest } from "../src/query/compile";
import { astToDsl } from "../src/query/normalize";
import { DslSyntaxError, parseDsl } from "../src/query/parser";
import { queryAstSchema } from "../src/query/ast";
import { QueryError } from "../src/registry";

const ctx = { orWindows: [5, 15, 30, 60], ibWindow: 60 };

describe("DSL parsing", () => {
  it("parses a bare outcome", () => {
    expect(parseDsl("gapFill")).toEqual({ outcome: { name: "gapFill", args: [] } });
  });

  it("round-trips the flagship composed query", () => {
    const dsl =
      "gapFill WHERE dayOfWeek = Tue AND fvgPresent(open, below) AND gapPct BETWEEN 0.2% AND 0.6% AND NOT eventDay('FOMC')";
    const ast = parseDsl(dsl);
    const normalized = astToDsl(ast);
    expect(parseDsl(normalized)).toEqual(ast);
    expect(astToDsl(parseDsl(normalized))).toBe(normalized);
  });

  it("binds AND tighter than OR and NOT tighter than AND", () => {
    const ast = parseDsl("closeGreen WHERE gapUp OR insideDay AND nr4");
    expect(ast.where).toMatchObject({
      t: "or",
      items: [{ t: "pred" }, { t: "and", items: [{ t: "pred" }, { t: "pred" }] }],
    });
    const notAst = parseDsl("closeGreen WHERE NOT gapUp AND nr4");
    expect(notAst.where).toMatchObject({ t: "and", items: [{ t: "not" }, { t: "pred" }] });
  });

  it("parses units: percent, minutes, hours", () => {
    const ast = parseDsl("orbBreak(1h) WHERE gapPct >= 0.5% AND gapFillMinutes <= 90m");
    expect(ast.outcome.args[0]).toEqual({ t: "num", v: 1, unit: "h" });
  });

  it("reports positions with the offending span", () => {
    try {
      parseDsl("gapFill WHERE ");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DslSyntaxError);
      expect((err as DslSyntaxError).pos).toBe(14);
    }
    try {
      parseDsl("gapFill WHERE eventDay('FOMC");
      expect.unreachable();
    } catch (err) {
      expect((err as DslSyntaxError).message).toContain("unterminated");
    }
  });

  it("does not lex 15min as a duration", () => {
    expect(() => parseDsl("orbBreak(15min)")).toThrow(DslSyntaxError);
  });

  it("validates the AST schema for hand-built payloads", () => {
    const good = { outcome: { name: "gapFill", args: [] } };
    expect(queryAstSchema.parse(good).outcome.name).toBe("gapFill");
    const bad = {
      outcome: { name: "gapFill" },
      where: { t: "cmp", left: { name: "x" }, op: "~", right: { t: "num", v: 1 } },
    };
    expect(() => queryAstSchema.parse(bad)).toThrow();
  });
});

describe("compilation against the registry", () => {
  it("suggests near-miss names", () => {
    expect(suggest("gapFil", ["gapFill", "closeGreen"])).toBe("gapFill");
    try {
      compileQuery(parseDsl("gapFil"), ctx);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).hint).toContain("gapFill");
    }
  });

  it("suggests near-miss enum values", () => {
    try {
      compileQuery(parseDsl("closeGreen WHERE dayOfWeek = Teu"), ctx);
      expect.unreachable();
    } catch (err) {
      expect((err as QueryError).hint).toContain("Tue");
    }
  });

  it("rejects underived opening-range windows with the fix in the hint", () => {
    try {
      compileQuery(parseDsl("orbBreak(20m)"), ctx);
      expect.unreachable();
    } catch (err) {
      expect((err as QueryError).message).toContain("20-minute");
      expect((err as QueryError).hint).toContain("orWindows");
    }
  });

  it("rejects unit mismatches", () => {
    expect(() => compileQuery(parseDsl("orbBreak(15%)"), ctx)).toThrow(QueryError);
    expect(() => compileQuery(parseDsl("closeGreen WHERE green >= 1"), ctx)).toThrow(QueryError);
    expect(() => compileQuery(parseDsl("closeGreen WHERE retOcPct >= 15m"), ctx)).toThrow(
      QueryError,
    );
  });

  it("requires arguments with a signature hint", () => {
    try {
      compileQuery(parseDsl("closeGreen WHERE streak(green)"), ctx);
      expect.unreachable();
    } catch (err) {
      expect((err as QueryError).message).toContain("missing required argument");
      expect((err as QueryError).hint).toContain("streak(dir, n)");
    }
  });

  it("compiles the flagship query to SQL touching the expected columns", () => {
    const compiled = compileQuery(
      parseDsl(
        "gapFill WHERE dayOfWeek = Tue AND fvgPresent(open, below) AND gapPct BETWEEN 0.2% AND 0.6% AND NOT eventDay('FOMC')",
      ),
      ctx,
    );
    expect(compiled.eligibilitySql).toContain("gap_dir");
    expect(compiled.successSql).toContain("gap_filled");
    expect(compiled.whereSql).toContain("f.dow");
    expect(compiled.whereSql).toContain("f.fvg_below");
    expect(compiled.whereSql).toContain("BETWEEN 0.2 AND 0.6");
    expect(compiled.whereSql).toContain("e.event = 'FOMC'");
    expect(compiled.normalizedDsl).toContain("WHERE");
  });

  it("treats bare boolean fields as predicates and rejects bare numerics", () => {
    expect(compileQuery(parseDsl("closeGreen WHERE insideDay"), ctx).whereSql).toContain(
      "f.inside_day",
    );
    expect(() => compileQuery(parseDsl("closeGreen WHERE gapPct"), ctx)).toThrow(QueryError);
  });
});
