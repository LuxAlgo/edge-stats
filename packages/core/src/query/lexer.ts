export type TokenType =
  "ident" | "number" | "string" | "lparen" | "rparen" | "comma" | "op" | "eof";

export interface Token {
  type: TokenType;
  /** Raw text (idents keep their case; keywords are matched case-insensitively later). */
  text: string;
  /** Parsed numeric value for number tokens. */
  value?: number;
  /** Unit suffix for number tokens: % (percent), m (minutes), h (hours). */
  unit?: "%" | "m" | "h";
  pos: number;
  len: number;
}

export class DslSyntaxError extends Error {
  constructor(
    message: string,
    readonly pos: number,
    readonly len = 1,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "DslSyntaxError";
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === undefined) break;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", text: "(", pos: i, len: 1 });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", text: ")", pos: i, len: 1 });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", text: ",", pos: i, len: 1 });
      i += 1;
      continue;
    }
    if (ch === ">" || ch === "<" || ch === "=" || ch === "!") {
      const two = input.slice(i, i + 2);
      if (two === ">=" || two === "<=" || two === "!=") {
        tokens.push({ type: "op", text: two, pos: i, len: 2 });
        i += 2;
        continue;
      }
      if (ch === "!") throw new DslSyntaxError(`unexpected '!'`, i, 1, "use '!=' or NOT");
      tokens.push({ type: "op", text: ch, pos: i, len: 1 });
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let out = "";
      while (j < input.length && input[j] !== quote) {
        out += input[j];
        j += 1;
      }
      if (j >= input.length) {
        throw new DslSyntaxError("unterminated string", i, input.length - i);
      }
      tokens.push({ type: "string", text: out, pos: i, len: j - i + 1 });
      i = j + 1;
      continue;
    }
    const isNegNumber = ch === "-" && i + 1 < input.length && DIGIT.test(input[i + 1] ?? "");
    if (DIGIT.test(ch) || isNegNumber) {
      let j = i + (isNegNumber ? 1 : 0);
      while (j < input.length && DIGIT.test(input[j] ?? "")) j += 1;
      if (input[j] === ".") {
        j += 1;
        while (j < input.length && DIGIT.test(input[j] ?? "")) j += 1;
      }
      let unit: "%" | "m" | "h" | undefined;
      const suffix = input[j];
      const after = input[j + 1];
      if (suffix === "%") {
        unit = "%";
        j += 1;
      } else if (
        (suffix === "m" || suffix === "h") &&
        (after === undefined || !IDENT_CHAR.test(after))
      ) {
        unit = suffix;
        j += 1;
      }
      const text = input.slice(i, j);
      const numText = unit ? text.slice(0, -1) : text;
      tokens.push({ type: "number", text, value: Number(numText), unit, pos: i, len: j - i });
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < input.length && IDENT_CHAR.test(input[j] ?? "")) j += 1;
      tokens.push({ type: "ident", text: input.slice(i, j), pos: i, len: j - i });
      i = j;
      continue;
    }
    throw new DslSyntaxError(`unexpected character '${ch}'`, i);
  }
  tokens.push({ type: "eof", text: "", pos: input.length, len: 0 });
  return tokens;
}
