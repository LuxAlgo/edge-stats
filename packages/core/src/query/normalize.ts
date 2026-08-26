/*
  AST → canonical DSL string. Every result echoes this back so humans and
  agents can see exactly how their query was understood (mis-parses show up
  immediately), and round-trip tests pin the grammar.
*/
import type { Call, Expr, Literal, QueryAst } from "./ast";

export function literalToDsl(lit: Literal): string {
  switch (lit.t) {
    case "num":
      return `${lit.v}${lit.unit ?? ""}`;
    case "str":
      return `'${lit.v.replaceAll("'", "''")}'`;
    case "word":
      return lit.v;
  }
}

export function callToDsl(call: Call): string {
  if (call.args.length === 0) return call.name;
  return `${call.name}(${call.args.map(literalToDsl).join(", ")})`;
}

function exprToDsl(expr: Expr, parentPrecedence: number): string {
  switch (expr.t) {
    case "or": {
      const rendered = expr.items.map((e) => exprToDsl(e, 1)).join(" OR ");
      return parentPrecedence > 1 ? `(${rendered})` : rendered;
    }
    case "and": {
      const rendered = expr.items.map((e) => exprToDsl(e, 2)).join(" AND ");
      return parentPrecedence > 2 ? `(${rendered})` : rendered;
    }
    case "not":
      return `NOT ${exprToDsl(expr.item, 3)}`;
    case "pred":
      return callToDsl(expr.call);
    case "cmp":
      return `${callToDsl(expr.left)} ${expr.op} ${literalToDsl(expr.right)}`;
    case "between":
      return `${callToDsl(expr.left)} BETWEEN ${literalToDsl(expr.lo)} AND ${literalToDsl(expr.hi)}`;
    case "in":
      return `${callToDsl(expr.left)} IN (${expr.items.map(literalToDsl).join(", ")})`;
  }
}

export function astToDsl(ast: QueryAst): string {
  const outcome = callToDsl(ast.outcome);
  if (!ast.where) return outcome;
  return `${outcome} WHERE ${exprToDsl(ast.where, 0)}`;
}
