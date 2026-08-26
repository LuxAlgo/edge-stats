/*
  The canonical query form: a zod-typed JSON AST. The string DSL parses to
  this; agents and the dashboard can also produce it directly. DSL ⇄ AST
  round-trips are tested — the AST is the contract.
*/
import { z } from "zod";

export const literalSchema = z.union([
  z.object({
    t: z.literal("num"),
    v: z.number(),
    /** '%' annotates percent fields; 'm'/'h' are durations (minutes/hours). */
    unit: z.enum(["%", "m", "h"]).optional(),
  }),
  z.object({ t: z.literal("str"), v: z.string() }),
  z.object({ t: z.literal("word"), v: z.string() }),
]);
export type Literal = z.infer<typeof literalSchema>;

export const callSchema = z.object({
  name: z.string(),
  args: z.array(literalSchema).default([]),
});
export type Call = z.infer<typeof callSchema>;

export const CMP_OPS = ["=", "!=", ">", ">=", "<", "<="] as const;
export type CmpOp = (typeof CMP_OPS)[number];

export type Expr =
  | { t: "and"; items: Expr[] }
  | { t: "or"; items: Expr[] }
  | { t: "not"; item: Expr }
  | { t: "pred"; call: Call }
  | { t: "cmp"; left: Call; op: CmpOp; right: Literal }
  | { t: "between"; left: Call; lo: Literal; hi: Literal }
  | { t: "in"; left: Call; items: Literal[] };

export const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ t: z.literal("and"), items: z.array(exprSchema).min(1) }),
    z.object({ t: z.literal("or"), items: z.array(exprSchema).min(1) }),
    z.object({ t: z.literal("not"), item: exprSchema }),
    z.object({ t: z.literal("pred"), call: callSchema }),
    z.object({
      t: z.literal("cmp"),
      left: callSchema,
      op: z.enum(CMP_OPS),
      right: literalSchema,
    }),
    z.object({ t: z.literal("between"), left: callSchema, lo: literalSchema, hi: literalSchema }),
    z.object({ t: z.literal("in"), left: callSchema, items: z.array(literalSchema).min(1) }),
  ]),
) as z.ZodType<Expr>;

export const queryAstSchema = z.object({
  outcome: callSchema,
  where: exprSchema.optional(),
});
export type QueryAst = z.infer<typeof queryAstSchema>;
