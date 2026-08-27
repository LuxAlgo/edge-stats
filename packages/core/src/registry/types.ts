/*
  The registry is the single source of truth: every field, predicate, and
  outcome the engine knows exists exactly once, here. The DSL validates
  against it, the SQL compiler compiles from it, `edgestats fields` prints
  it, the MCP server describes tools with it, the dashboard builds its
  filter UI from it, and the docs table is generated from it. A predicate
  that is not in the registry does not exist.
*/

export type ArgType = "number" | "duration" | "enum" | "string";

export interface ArgSpec {
  name: string;
  type: ArgType;
  /** Allowed values for enum args. */
  values?: readonly string[];
  required?: boolean;
  default?: number | string;
  doc: string;
}

export interface LibraryRef {
  kind: "concept" | "indicator";
  slug: string;
}

export function libraryUrl(ref: LibraryRef): string {
  return `https://www.luxalgo.com/library/${ref.kind}/${ref.slug}/`;
}

/** Values after arg validation: durations are minutes, enums are their string value. */
export type ResolvedArgs = Record<string, number | string>;

export interface CompileCtx {
  /** Opening-range windows (minutes) derived for the symbol being queried. */
  orWindows: number[];
  /** Initial-balance window (minutes). */
  ibWindow: number;
}

interface DefBase {
  name: string;
  title: string;
  doc: string;
  examples?: string[];
  library?: LibraryRef[];
}

export interface FieldDef extends DefBase {
  kind: "field";
  valueType: "number" | "boolean" | "enum";
  unit?: "%" | "minutes" | "price" | "ratio" | "count" | "r";
  enumValues?: readonly string[];
  /** SQL expression over session_features alias `f`. */
  sql: string;
  /** Whether results may be grouped by this field. */
  groupable?: boolean;
}

export interface PredicateDef extends DefBase {
  kind: "predicate";
  args: ArgSpec[];
  sql: (args: ResolvedArgs, ctx: CompileCtx) => string;
}

export interface OutcomeDef extends DefBase {
  kind: "outcome";
  args: ArgSpec[];
  /** Which sessions the question even applies to (the denominator). */
  eligibility: (args: ResolvedArgs, ctx: CompileCtx) => string;
  /** The measured event (the numerator). */
  success: (args: ResolvedArgs, ctx: CompileCtx) => string;
  /** Optional continuous measurement reported as a distribution. */
  value?: {
    sql: (args: ResolvedArgs, ctx: CompileCtx) => string;
    unit: string;
    doc: string;
  };
}

export type RegistryDef = FieldDef | PredicateDef | OutcomeDef;

export class QueryError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly position?: number,
    readonly length?: number,
  ) {
    super(message);
    this.name = "QueryError";
  }
}

/** Guard: an OR-window argument must be one of the derived windows. */
export function requireWindow(minutes: number, ctx: CompileCtx): number {
  if (!ctx.orWindows.includes(minutes)) {
    throw new QueryError(
      `no ${minutes}-minute opening-range window derived for this symbol`,
      `derived windows: ${ctx.orWindows.map((w) => `${w}m`).join(", ")}: add ${minutes} to the symbol's orWindows in edge-stats.config.json and re-run \`edgestats sync\``,
    );
  }
  return minutes;
}
