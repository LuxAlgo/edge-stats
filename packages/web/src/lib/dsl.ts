/*
  The query builder's model and its DSL renderer. The builder composes the
  same string DSL the CLI and MCP server accept; the server parses it back
  to the canonical AST, so what you see in the DSL box is exactly what runs.
*/
import type { RegistryArg, RegistryEntryDescription } from "./api";

export type ArgValues = Record<string, string>;

export interface OutcomeState {
  name: string;
  args: ArgValues;
}

export type CompareOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "between" | "in" | "is";

export interface ConditionRow {
  id: number;
  /** Registry name: a predicate (call mode) or a field (compare mode). */
  name: string;
  not: boolean;
  /** Predicate arguments, raw input text keyed by arg name. */
  args: ArgValues;
  /** Field comparison. */
  op: CompareOp;
  value: string;
  valueHi: string;
  /** IN-list selections for enum fields. */
  values: string[];
}

export interface ConditionGroup {
  id: number;
  rows: ConditionRow[];
}

export interface BuilderState {
  outcome: OutcomeState;
  /** Rows AND'ed together. */
  rows: ConditionRow[];
  /** Each group's rows are OR'ed, and the group is AND'ed into the whole. */
  groups: ConditionGroup[];
}

let nextId = 1;
export function freshId(): number {
  nextId += 1;
  return nextId;
}

export function emptyRow(name = ""): ConditionRow {
  return { id: freshId(), name, not: false, args: {}, op: "=", value: "", valueHi: "", values: [] };
}

export function defaultOpFor(entry: RegistryEntryDescription | undefined): CompareOp {
  if (!entry) return "=";
  if (entry.kind !== "field") return "=";
  if (entry.valueType === "boolean") return "is";
  if (entry.valueType === "number") return ">=";
  return "=";
}

export function opsFor(entry: RegistryEntryDescription): CompareOp[] {
  if (entry.valueType === "boolean") return ["is"];
  if (entry.valueType === "enum") return ["=", "!=", "in"];
  return ["=", "!=", ">", ">=", "<", "<=", "between"];
}

function isFiniteNumberText(text: string): boolean {
  return text.trim() !== "" && Number.isFinite(Number(text));
}

/** Suffix numeric literals with the field's unit so the DSL reads naturally. */
function numberLiteral(text: string, unit: string | undefined): string | null {
  if (!isFiniteNumberText(text)) return null;
  const v = Number(text);
  if (unit === "%") return `${v}%`;
  if (unit === "minutes") return `${v}m`;
  return `${v}`;
}

function argLiteral(spec: RegistryArg, raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  switch (spec.type) {
    case "duration": {
      if (!isFiniteNumberText(text)) return null;
      return `${Number(text)}m`;
    }
    case "number": {
      if (!isFiniteNumberText(text)) return null;
      return `${Number(text)}`;
    }
    case "enum":
      return text;
    default:
      return `'${text.replaceAll("'", "''")}'`;
  }
}

/**
 * Render a registry call (outcome or predicate). Arguments are positional:
 * blanks in the middle fall back to the spec default; a required blank with
 * no default makes the call incomplete (null) so nothing half-typed runs.
 */
export function callDsl(entry: RegistryEntryDescription, args: ArgValues): string | null {
  const specs = entry.args ?? [];
  const rendered: (string | null)[] = specs.map((spec) => {
    const given = argLiteral(spec, args[spec.name] ?? "");
    if (given !== null) return given;
    if (spec.default !== undefined) {
      return spec.type === "duration" ? `${String(spec.default)}m` : String(spec.default);
    }
    return spec.required ? null : "";
  });
  // Trim trailing omitted optionals, then require everything remaining.
  while (rendered.length > 0 && rendered[rendered.length - 1] === "") rendered.pop();
  const parts: string[] = [];
  for (const r of rendered) {
    if (r === null || r === "") return null;
    parts.push(r);
  }
  if (parts.length === 0) return entry.name;
  return `${entry.name}(${parts.join(", ")})`;
}

/** Render one condition row; null while the row is still incomplete. */
export function rowDsl(
  row: ConditionRow,
  byName: Map<string, RegistryEntryDescription>,
): string | null {
  const entry = byName.get(row.name);
  if (!entry) return null;

  if (entry.kind === "predicate") {
    const call = callDsl(entry, row.args);
    if (call === null) return null;
    return row.not ? `NOT ${call}` : call;
  }
  if (entry.kind !== "field") return null;

  if (entry.valueType === "boolean") {
    const isTrue = row.value !== "false";
    const negated = row.not !== !isTrue; // NOT toggle XOR "is false"
    return negated ? `NOT ${entry.name}` : entry.name;
  }

  if (row.op === "in") {
    if (row.values.length === 0) return null;
    const body = `${entry.name} IN (${row.values.join(", ")})`;
    return row.not ? `NOT ${body}` : body;
  }
  if (row.op === "between") {
    const lo = numberLiteral(row.value, entry.unit);
    const hi = numberLiteral(row.valueHi, entry.unit);
    if (lo === null || hi === null) return null;
    const body = `${entry.name} BETWEEN ${lo} AND ${hi}`;
    return row.not ? `NOT ${body}` : body;
  }

  const literal =
    entry.valueType === "enum"
      ? row.value === ""
        ? null
        : row.value
      : numberLiteral(row.value, entry.unit);
  if (literal === null) return null;
  const op = row.op === "is" ? "=" : row.op;
  const body = `${entry.name} ${op} ${literal}`;
  return row.not ? `NOT ${body}` : body;
}

export interface ComposedDsl {
  /** The runnable DSL, or null while the outcome itself is incomplete. */
  dsl: string | null;
  /** Rows currently missing a value (shown, but excluded from the DSL). */
  incompleteRows: number;
}

export function composeDsl(
  state: BuilderState,
  byName: Map<string, RegistryEntryDescription>,
): ComposedDsl {
  const outcomeEntry = byName.get(state.outcome.name);
  const outcomeCall = outcomeEntry ? callDsl(outcomeEntry, state.outcome.args) : null;
  let incomplete = outcomeEntry && outcomeCall === null ? 1 : 0;

  const parts: string[] = [];
  for (const row of state.rows) {
    if (row.name === "") continue;
    const d = rowDsl(row, byName);
    if (d === null) incomplete += 1;
    else parts.push(d);
  }
  for (const group of state.groups) {
    const rendered: string[] = [];
    for (const row of group.rows) {
      if (row.name === "") continue;
      const d = rowDsl(row, byName);
      if (d === null) incomplete += 1;
      else rendered.push(d);
    }
    const first = rendered[0];
    if (rendered.length === 1 && first !== undefined) parts.push(first);
    else if (rendered.length > 1) parts.push(`(${rendered.join(" OR ")})`);
  }

  if (outcomeCall === null) return { dsl: null, incompleteRows: incomplete };
  const dsl = parts.length > 0 ? `${outcomeCall} WHERE ${parts.join(" AND ")}` : outcomeCall;
  return { dsl, incompleteRows: incomplete };
}
