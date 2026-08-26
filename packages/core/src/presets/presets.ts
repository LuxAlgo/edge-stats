/*
  Presets: the report catalog. Each preset is one versioned JSON file —
  an outcome, an optional base condition, parameters that expand into DSL
  fragments, and original definition prose. The catalog page, the CLI, the
  dashboard, and the MCP server all enumerate the same folder. "N reports"
  stops being a moat when it's a folder anyone can extend by pull request.
*/
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { EdgeStatsConfig } from "../config";
import { QueryError } from "../registry";
import type { QueryResult } from "../query/execute";
import { runQuery } from "../query/execute";
import { parseDsl } from "../query/parser";
import { astToDsl } from "../query/normalize";
import type { Store } from "../store/store";

export const presetParamSchema = z.object({
  name: z.string(),
  type: z.enum(["number", "duration", "enum", "string"]),
  values: z.array(z.string()).optional(),
  default: z.union([z.number(), z.string()]).optional(),
  doc: z.string(),
  /** DSL fragment with {value} placeholder, ANDed into the WHERE clause when the param is set. */
  fragment: z.string().optional(),
  /** Substitutes into the outcome call instead of the WHERE clause. */
  target: z.enum(["where", "outcome"]).default("where"),
});
export type PresetParam = z.infer<typeof presetParamSchema>;

export const presetSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.number().int().positive(),
  title: z.string(),
  category: z.string(),
  /** Original definition prose — what the number means, in plain language. */
  summary: z.string(),
  /** Outcome call template; {param} placeholders substitute outcome-target params. */
  outcome: z.string(),
  /** Base condition DSL (optional). */
  where: z.string().optional(),
  params: z.array(presetParamSchema).default([]),
  /** Default grouping (a groupable registry field), overridable per run. */
  groupBy: z.string().optional(),
  /** What this preset offers beyond the fixed-report version of the same stat. */
  deltas: z.array(z.string()).default([]),
  library: z
    .array(z.object({ kind: z.enum(["concept", "indicator"]), slug: z.string() }))
    .default([]),
});
export type Preset = z.infer<typeof presetSchema>;

export function presetsDir(dataDir: string): string {
  return join(dataDir, "presets");
}

export function loadPresets(dir: string): Preset[] {
  if (!existsSync(dir)) return [];
  const presets: Preset[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = presetSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
    presets.push(parsed);
  }
  const ids = new Set<string>();
  for (const p of presets) {
    if (ids.has(p.id)) throw new Error(`duplicate preset id '${p.id}'`);
    ids.add(p.id);
  }
  return presets;
}

export function findPreset(presets: Preset[], id: string): Preset {
  const preset = presets.find((p) => p.id === id);
  if (!preset) {
    throw new QueryError(
      `unknown preset '${id}'`,
      `available presets: ${presets.map((p) => p.id).join(", ")}`,
    );
  }
  return preset;
}

function formatParamValue(param: PresetParam, value: number | string): string {
  if (param.type === "duration") return `${value}m`;
  if (param.type === "string") return `'${String(value).replaceAll("'", "''")}'`;
  return String(value);
}

export interface PresetRunRequest {
  presetId: string;
  symbol: string;
  params?: Record<string, number | string>;
  sessionKey?: string;
  since?: string;
  until?: string;
  groupBy?: string;
  sessionsLimit?: number;
  force?: boolean;
}

export interface PresetRunResult extends QueryResult {
  preset: { id: string; version: number; title: string; params: Record<string, number | string> };
}

/** Compose a preset + parameters into a plain DSL query string. */
export function composePresetDsl(
  preset: Preset,
  params: Record<string, number | string>,
): { dsl: string; resolved: Record<string, number | string> } {
  const resolved: Record<string, number | string> = {};
  for (const spec of preset.params) {
    const given = params[spec.name];
    const value = given !== undefined ? given : spec.default;
    if (value === undefined) continue;
    if (spec.type === "enum" && spec.values && !spec.values.includes(String(value))) {
      throw new QueryError(
        `preset '${preset.id}': '${String(value)}' is not a valid ${spec.name}`,
        `valid values: ${spec.values.join(", ")}`,
      );
    }
    if (spec.type === "number" || spec.type === "duration") {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) {
        throw new QueryError(`preset '${preset.id}': param '${spec.name}' must be a number`);
      }
      resolved[spec.name] = n;
    } else {
      resolved[spec.name] = value;
    }
  }
  const unknown = Object.keys(params).filter((k) => !preset.params.some((p) => p.name === k));
  if (unknown.length > 0) {
    throw new QueryError(
      `preset '${preset.id}' has no param '${unknown[0]}'`,
      preset.params.length > 0
        ? `params: ${preset.params.map((p) => p.name).join(", ")}`
        : "this preset takes no params",
    );
  }

  let outcome = preset.outcome;
  const whereParts: string[] = [];
  if (preset.where) whereParts.push(`(${preset.where})`);
  for (const spec of preset.params) {
    const value = resolved[spec.name];
    if (value === undefined) continue;
    const formatted = formatParamValue(spec, value);
    if (spec.target === "outcome") {
      outcome = outcome.replaceAll(`{${spec.name}}`, formatted);
    } else if (spec.fragment) {
      whereParts.push(`(${spec.fragment.replaceAll("{value}", formatted)})`);
    }
  }
  if (outcome.includes("{")) {
    throw new QueryError(`preset '${preset.id}': unresolved outcome placeholder in '${outcome}'`);
  }
  const dsl = whereParts.length > 0 ? `${outcome} WHERE ${whereParts.join(" AND ")}` : outcome;
  // Normalize through the parser so presets are guaranteed valid DSL.
  return { dsl: astToDsl(parseDsl(dsl)), resolved };
}

export async function runPreset(
  store: Store,
  config: EdgeStatsConfig,
  presets: Preset[],
  req: PresetRunRequest,
): Promise<PresetRunResult> {
  const preset = findPreset(presets, req.presetId);
  const { dsl, resolved } = composePresetDsl(preset, req.params ?? {});
  const result = await runQuery(store, config, {
    dsl,
    symbol: req.symbol,
    sessionKey: req.sessionKey,
    since: req.since,
    until: req.until,
    groupBy: req.groupBy ?? preset.groupBy,
    sessionsLimit: req.sessionsLimit,
    force: req.force,
  });
  return {
    ...result,
    preset: { id: preset.id, version: preset.version, title: preset.title, params: resolved },
  };
}
