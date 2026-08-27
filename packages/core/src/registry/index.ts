import { fields } from "./fields";
import { outcomes } from "./outcomes";
import { predicates } from "./predicates";
import type { FieldDef, OutcomeDef, PredicateDef, RegistryDef } from "./types";

export * from "./types";
export { fields, WEEKDAYS, GAP_DIRS, GAP_BUCKETS, IB_BREAKS } from "./fields";
export { predicates } from "./predicates";
export { outcomes } from "./outcomes";

export interface Registry {
  fields: Map<string, FieldDef>;
  predicates: Map<string, PredicateDef>;
  outcomes: Map<string, OutcomeDef>;
  all: Map<string, RegistryDef>;
}

function buildRegistry(): Registry {
  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  const predicateMap = new Map(predicates.map((p) => [p.name, p]));
  const outcomeMap = new Map(outcomes.map((o) => [o.name, o]));
  const all = new Map<string, RegistryDef>();
  for (const def of [...fields, ...predicates, ...outcomes]) {
    if (all.has(def.name)) throw new Error(`duplicate registry name: ${def.name}`);
    all.set(def.name, def);
  }
  return { fields: fieldMap, predicates: predicateMap, outcomes: outcomeMap, all };
}

export const registry: Registry = buildRegistry();

export interface RegistryEntryDescription {
  name: string;
  kind: "field" | "predicate" | "outcome";
  title: string;
  doc: string;
  valueType?: string;
  unit?: string;
  enumValues?: readonly string[];
  groupable?: boolean;
  args?: {
    name: string;
    type: string;
    values?: readonly string[];
    required: boolean;
    default?: number | string;
    doc: string;
  }[];
  valueDoc?: string;
  valueUnit?: string;
  examples?: string[];
  library?: { kind: string; slug: string; url: string }[];
}

/** Serializable registry description: drives the CLI, MCP, dashboard, and docs. */
export function describeRegistry(
  kind?: "field" | "predicate" | "outcome",
): RegistryEntryDescription[] {
  const defs = [...registry.all.values()].filter((d) => !kind || d.kind === kind);
  return defs.map((def) => {
    const base: RegistryEntryDescription = {
      name: def.name,
      kind: def.kind,
      title: def.title,
      doc: def.doc,
    };
    if (def.examples) base.examples = def.examples;
    if (def.library) {
      base.library = def.library.map((ref) => ({
        kind: ref.kind,
        slug: ref.slug,
        url: `https://www.luxalgo.com/library/${ref.kind}/${ref.slug}/`,
      }));
    }
    if (def.kind === "field") {
      base.valueType = def.valueType;
      if (def.unit) base.unit = def.unit;
      if (def.enumValues) base.enumValues = def.enumValues;
      if (def.groupable) base.groupable = def.groupable;
    } else {
      base.args = def.args.map((a) => ({
        name: a.name,
        type: a.type,
        ...(a.values ? { values: a.values } : {}),
        required: a.required ?? false,
        ...(a.default !== undefined ? { default: a.default } : {}),
        doc: a.doc,
      }));
      if (def.kind === "outcome" && def.value) {
        base.valueDoc = def.value.doc;
        base.valueUnit = def.value.unit;
      }
    }
    return base;
  });
}

/** Groupable field names (for query groupBy validation). */
export function groupableFields(): string[] {
  return fields.filter((f) => f.groupable).map((f) => f.name);
}
