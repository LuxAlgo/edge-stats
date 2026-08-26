/*
  AST → DuckDB SQL, validated against the registry. Unknown names get
  did-you-mean suggestions; argument and unit mismatches get positionless
  QueryErrors with hints (the DSL layer adds positions where it has them).
*/
import type {
  ArgSpec,
  CompileCtx,
  FieldDef,
  OutcomeDef,
  PredicateDef,
  ResolvedArgs,
} from "../registry";
import { QueryError, registry } from "../registry";
import { sqlNum, sqlStr } from "../util/sql";
import type { Call, Expr, Literal, QueryAst } from "./ast";
import { astToDsl, callToDsl } from "./normalize";

function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const row = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j += 1) row[j] = j;
  for (let i = 1; i <= la; i += 1) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= lb; j += 1) {
      const tmp = row[j] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(tmp + 1, (row[j - 1] as number) + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[lb] as number;
}

export function suggest(name: string, candidates: Iterable<string>): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const cl = c.toLowerCase();
    if (cl === lower) return c;
    const d = levenshtein(lower, cl);
    const prefixBonus = cl.startsWith(lower) || lower.startsWith(cl) ? -1 : 0;
    const score = d + prefixBonus;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore <= 2 ? best : null;
}

function unknownName(name: string, kind: string, candidates: Iterable<string>): QueryError {
  const s = suggest(name, candidates);
  return new QueryError(
    `unknown ${kind} '${name}'`,
    s
      ? `did you mean '${s}'? Run \`edgestats fields\` for the full registry.`
      : "run `edgestats fields` for the full registry.",
  );
}

function literalKind(lit: Literal): string {
  return lit.t === "num"
    ? `number${lit.unit ? ` (${lit.unit})` : ""}`
    : lit.t === "str"
      ? "string"
      : "word";
}

/** Coerce one literal against an ArgSpec; durations normalize to minutes. */
function coerceArg(def: { name: string }, spec: ArgSpec, lit: Literal): number | string {
  switch (spec.type) {
    case "duration": {
      if (lit.t !== "num") {
        throw new QueryError(
          `${def.name}(): argument '${spec.name}' wants a duration, got ${literalKind(lit)}`,
          `write durations as 15m or 1h`,
        );
      }
      if (lit.unit === "%") {
        throw new QueryError(`${def.name}(): '${spec.name}' is a duration, not a percent`);
      }
      const minutes = lit.unit === "h" ? lit.v * 60 : lit.v;
      if (!Number.isInteger(minutes) || minutes <= 0) {
        throw new QueryError(
          `${def.name}(): '${spec.name}' must be a positive whole number of minutes`,
        );
      }
      return minutes;
    }
    case "number": {
      if (lit.t !== "num") {
        throw new QueryError(
          `${def.name}(): argument '${spec.name}' wants a number, got ${literalKind(lit)}`,
        );
      }
      if (lit.unit === "m" || lit.unit === "h") {
        throw new QueryError(`${def.name}(): '${spec.name}' is a plain number, not a duration`);
      }
      return lit.v;
    }
    case "enum": {
      if (lit.t === "num") {
        throw new QueryError(
          `${def.name}(): argument '${spec.name}' wants one of ${(spec.values ?? []).join("|")}, got a number`,
        );
      }
      const v = lit.v;
      if (!spec.values?.includes(v)) {
        const s = suggest(v, spec.values ?? []);
        throw new QueryError(
          `${def.name}(): '${v}' is not a valid ${spec.name}`,
          `${s ? `did you mean '${s}'? ` : ""}valid values: ${(spec.values ?? []).join(", ")}`,
        );
      }
      return v;
    }
    case "string": {
      if (lit.t === "num") {
        throw new QueryError(`${def.name}(): argument '${spec.name}' wants a string`);
      }
      return lit.v;
    }
  }
}

export function resolveArgs(def: PredicateDef | OutcomeDef, call: Call): ResolvedArgs {
  const specs = def.args;
  if (call.args.length > specs.length) {
    throw new QueryError(
      `${def.name}() takes at most ${specs.length} argument${specs.length === 1 ? "" : "s"}, got ${call.args.length}`,
      specs.length > 0
        ? `signature: ${def.name}(${specs.map((s) => s.name).join(", ")})`
        : undefined,
    );
  }
  const out: ResolvedArgs = {};
  specs.forEach((spec, i) => {
    const lit = call.args[i];
    if (lit === undefined) {
      if (spec.default !== undefined) {
        out[spec.name] = spec.default;
      } else if (spec.required) {
        throw new QueryError(
          `${def.name}() is missing required argument '${spec.name}'`,
          `signature: ${def.name}(${specs.map((s) => s.name).join(", ")}) — ${spec.doc}`,
        );
      }
      return;
    }
    out[spec.name] = coerceArg(def, spec, lit);
  });
  return out;
}

function fieldLiteralSql(field: FieldDef, lit: Literal): string {
  switch (field.valueType) {
    case "number": {
      if (lit.t !== "num") {
        throw new QueryError(`'${field.name}' is numeric; compare it with a number`);
      }
      if (lit.unit === "%" && field.unit !== "%") {
        throw new QueryError(
          `'${field.name}' is measured in ${field.unit ?? "plain units"}, not percent`,
        );
      }
      if ((lit.unit === "m" || lit.unit === "h") && field.unit !== "minutes") {
        throw new QueryError(`'${field.name}' is not a duration field`);
      }
      const v = lit.unit === "h" ? lit.v * 60 : lit.v;
      return sqlNum(v);
    }
    case "boolean": {
      const word = lit.t === "word" ? lit.v.toLowerCase() : null;
      if (word === "true") return "TRUE";
      if (word === "false") return "FALSE";
      throw new QueryError(
        `'${field.name}' is boolean; compare with true or false (or use it bare)`,
      );
    }
    case "enum": {
      if (lit.t === "num") {
        throw new QueryError(
          `'${field.name}' takes one of: ${(field.enumValues ?? []).join(", ")}`,
        );
      }
      const v = lit.v;
      if (!field.enumValues?.includes(v)) {
        const s = suggest(v, field.enumValues ?? []);
        throw new QueryError(
          `'${v}' is not a valid ${field.name}`,
          `${s ? `did you mean '${s}'? ` : ""}valid values: ${(field.enumValues ?? []).join(", ")}`,
        );
      }
      return sqlStr(v);
    }
  }
}

function resolveField(call: Call): FieldDef {
  const field = registry.fields.get(call.name);
  if (!field) {
    throw unknownName(call.name, "field", registry.fields.keys());
  }
  if (call.args.length > 0) {
    throw new QueryError(`'${field.name}' is a field, not a function — drop the parentheses`);
  }
  return field;
}

function compileExpr(expr: Expr, ctx: CompileCtx): string {
  switch (expr.t) {
    case "and":
      return `(${expr.items.map((e) => compileExpr(e, ctx)).join(" AND ")})`;
    case "or":
      return `(${expr.items.map((e) => compileExpr(e, ctx)).join(" OR ")})`;
    case "not": {
      // SQL three-valued logic would silently drop NULL rows into the
      // "neither" bucket; conditions treat NULL as false so NOT is a
      // complement over eligible sessions.
      return `(NOT coalesce(${compileExpr(expr.item, ctx)}, FALSE))`;
    }
    case "pred": {
      const pred = registry.predicates.get(expr.call.name);
      if (pred) {
        return `coalesce((${pred.sql(resolveArgs(pred, expr.call), ctx)}), FALSE)`;
      }
      const field = registry.fields.get(expr.call.name);
      if (field) {
        if (field.valueType !== "boolean") {
          throw new QueryError(
            `'${field.name}' is a ${field.valueType} field — compare it (e.g. ${field.name} ${field.valueType === "enum" ? `= ${field.enumValues?.[0] ?? "…"}` : ">= …"})`,
          );
        }
        if (expr.call.args.length > 0) {
          throw new QueryError(`'${field.name}' is a field, not a function — drop the parentheses`);
        }
        return `coalesce(${field.sql}, FALSE)`;
      }
      throw unknownName(expr.call.name, "predicate or field", [
        ...registry.predicates.keys(),
        ...registry.fields.keys(),
      ]);
    }
    case "cmp": {
      const field = resolveField(expr.left);
      const rhs = fieldLiteralSql(field, expr.right);
      const op = expr.op === "=" ? "=" : expr.op === "!=" ? "<>" : expr.op;
      return `coalesce(${field.sql} ${op} ${rhs}, FALSE)`;
    }
    case "between": {
      const field = resolveField(expr.left);
      if (field.valueType !== "number") {
        throw new QueryError(
          `BETWEEN needs a numeric field, and '${field.name}' is ${field.valueType}`,
        );
      }
      const lo = fieldLiteralSql(field, expr.lo);
      const hi = fieldLiteralSql(field, expr.hi);
      return `coalesce(${field.sql} BETWEEN ${lo} AND ${hi}, FALSE)`;
    }
    case "in": {
      const field = resolveField(expr.left);
      const items = expr.items.map((lit) => fieldLiteralSql(field, lit));
      return `coalesce(${field.sql} IN (${items.join(", ")}), FALSE)`;
    }
  }
}

export interface CompiledQuery {
  outcomeName: string;
  outcome: OutcomeDef;
  eligibilitySql: string;
  successSql: string;
  valueSql: string | null;
  valueUnit: string | null;
  whereSql: string | null;
  normalizedDsl: string;
}

export function compileQuery(ast: QueryAst, ctx: CompileCtx): CompiledQuery {
  const outcome = registry.outcomes.get(ast.outcome.name);
  if (!outcome) {
    throw unknownName(ast.outcome.name, "outcome", registry.outcomes.keys());
  }
  const args = resolveArgs(outcome, ast.outcome);
  const eligibilitySql = outcome.eligibility(args, ctx);
  const successSql = outcome.success(args, ctx);
  const valueSql = outcome.value ? outcome.value.sql(args, ctx) : null;
  const whereSql = ast.where ? compileExpr(ast.where, ctx) : null;
  return {
    outcomeName: callToDsl(ast.outcome),
    outcome,
    eligibilitySql,
    successSql,
    valueSql,
    valueUnit: outcome.value?.unit ?? null,
    whereSql,
    normalizedDsl: astToDsl(ast),
  };
}

export function compileConditionExpr(expr: Expr, ctx: CompileCtx): string {
  return compileExpr(expr, ctx);
}
