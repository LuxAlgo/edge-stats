/*
  Recursive-descent / Pratt parser for the query DSL:

    <outcome> [WHERE <boolExpr>]

    boolExpr := andExpr (OR andExpr)*          -- AND binds tighter than OR
    andExpr  := unary (AND unary)*
    unary    := NOT unary | primary
    primary  := '(' boolExpr ')' | atom
    atom     := call [cmp literal | BETWEEN literal AND literal | IN '(' literal, … ')']
    call     := IDENT ['(' literal {',' literal} ')']

  Errors carry exact positions; name resolution (with did-you-mean) happens
  at compile time against the registry.
*/
import type { Call, CmpOp, Expr, Literal, QueryAst } from "./ast";
import { CMP_OPS } from "./ast";
import type { Token } from "./lexer";
import { DslSyntaxError, lex } from "./lexer";

const KEYWORDS = new Set(["where", "and", "or", "not", "between", "in"]);

class Parser {
  private i = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    const t = this.tokens[this.i];
    if (!t) throw new Error("token stream exhausted");
    return t;
  }

  private next(): Token {
    const t = this.peek();
    this.i += 1;
    return t;
  }

  private isKeyword(t: Token, kw: string): boolean {
    return t.type === "ident" && t.text.toLowerCase() === kw;
  }

  private expect(type: Token["type"], what: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new DslSyntaxError(`expected ${what}, found ${describeToken(t)}`, t.pos, t.len || 1);
    }
    return this.next();
  }

  parseQuery(): QueryAst {
    const outcome = this.parseCall("an outcome");
    let where: Expr | undefined;
    const t = this.peek();
    if (this.isKeyword(t, "where")) {
      this.next();
      where = this.parseOr();
    }
    const end = this.peek();
    if (end.type !== "eof") {
      throw new DslSyntaxError(
        `unexpected ${describeToken(end)} after the query`,
        end.pos,
        end.len || 1,
        "did you mean to join conditions with AND / OR, or start them with WHERE?",
      );
    }
    return where ? { outcome, where } : { outcome };
  }

  /** Parse a bare condition expression (used by preset fragments). */
  parseExprOnly(): Expr {
    const expr = this.parseOr();
    const end = this.peek();
    if (end.type !== "eof") {
      throw new DslSyntaxError(`unexpected ${describeToken(end)}`, end.pos, end.len || 1);
    }
    return expr;
  }

  private parseOr(): Expr {
    const items: Expr[] = [this.parseAnd()];
    while (this.isKeyword(this.peek(), "or")) {
      this.next();
      items.push(this.parseAnd());
    }
    return items.length === 1 && items[0] ? items[0] : { t: "or", items };
  }

  private parseAnd(): Expr {
    const items: Expr[] = [this.parseUnary()];
    while (this.isKeyword(this.peek(), "and")) {
      this.next();
      items.push(this.parseUnary());
    }
    return items.length === 1 && items[0] ? items[0] : { t: "and", items };
  }

  private parseUnary(): Expr {
    if (this.isKeyword(this.peek(), "not")) {
      this.next();
      return { t: "not", item: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === "lparen") {
      this.next();
      const inner = this.parseOr();
      this.expect("rparen", "')'");
      return inner;
    }
    return this.parseAtom();
  }

  private parseAtom(): Expr {
    const left = this.parseCall("a field or predicate");
    const t = this.peek();
    if (t.type === "op" && (CMP_OPS as readonly string[]).includes(t.text)) {
      this.next();
      const right = this.parseLiteral();
      return { t: "cmp", left, op: t.text as CmpOp, right };
    }
    if (this.isKeyword(t, "between")) {
      this.next();
      const lo = this.parseLiteral();
      const andTok = this.peek();
      if (!this.isKeyword(andTok, "and")) {
        throw new DslSyntaxError(
          `expected AND in BETWEEN, found ${describeToken(andTok)}`,
          andTok.pos,
          andTok.len || 1,
        );
      }
      this.next();
      const hi = this.parseLiteral();
      return { t: "between", left, lo, hi };
    }
    if (this.isKeyword(t, "in")) {
      this.next();
      this.expect("lparen", "'(' after IN");
      const items: Literal[] = [this.parseLiteral()];
      while (this.peek().type === "comma") {
        this.next();
        items.push(this.parseLiteral());
      }
      this.expect("rparen", "')'");
      return { t: "in", left, items };
    }
    return { t: "pred", call: left };
  }

  private parseCall(what: string): Call {
    const t = this.peek();
    if (t.type !== "ident" || KEYWORDS.has(t.text.toLowerCase())) {
      throw new DslSyntaxError(`expected ${what}, found ${describeToken(t)}`, t.pos, t.len || 1);
    }
    this.next();
    const args: Literal[] = [];
    if (this.peek().type === "lparen") {
      this.next();
      if (this.peek().type !== "rparen") {
        args.push(this.parseLiteral());
        while (this.peek().type === "comma") {
          this.next();
          args.push(this.parseLiteral());
        }
      }
      this.expect("rparen", "')' to close the argument list");
    }
    return { name: t.text, args };
  }

  private parseLiteral(): Literal {
    const t = this.peek();
    if (t.type === "number") {
      this.next();
      const value = t.value ?? Number.NaN;
      return t.unit ? { t: "num", v: value, unit: t.unit } : { t: "num", v: value };
    }
    if (t.type === "string") {
      this.next();
      return { t: "str", v: t.text };
    }
    if (t.type === "ident" && !KEYWORDS.has(t.text.toLowerCase())) {
      this.next();
      return { t: "word", v: t.text };
    }
    throw new DslSyntaxError(
      `expected a value, found ${describeToken(t)}`,
      t.pos,
      t.len || 1,
      "values are numbers (0.5, 0.2%, 15m), quoted strings ('FOMC'), or bare words (Tue, up)",
    );
  }
}

function describeToken(t: Token): string {
  if (t.type === "eof") return "end of query";
  if (t.type === "string") return `string '${t.text}'`;
  return `'${t.text}'`;
}

export function parseDsl(input: string): QueryAst {
  return new Parser(lex(input)).parseQuery();
}

export function parseConditionDsl(input: string): Expr {
  return new Parser(lex(input)).parseExprOnly();
}

/** Render a parse/compile error with a caret under the offending span. */
export function renderDslError(input: string, err: DslSyntaxError): string {
  const caretLine = " ".repeat(err.pos) + "^".repeat(Math.max(1, err.len));
  const hint = err.hint ? `\nhint: ${err.hint}` : "";
  return `${err.message}\n  ${input}\n  ${caretLine}${hint}`;
}

export { DslSyntaxError };
