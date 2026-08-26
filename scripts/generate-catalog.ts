/*
  Generates docs/catalog.md — the preset catalog page — from presets/ and
  the registry. Deterministic: same presets + same registry ⇒ byte-identical
  output (the page is passed through the repo's own prettier config before
  it is written, so the committed file is always format-clean).

  Run with:  pnpm run gen:catalog   (or: pnpm exec tsx scripts/generate-catalog.ts)
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { composePresetDsl, loadPresets } from "../packages/core/src/presets/presets";
import type { Preset, PresetParam } from "../packages/core/src/presets/presets";
import { compileQuery } from "../packages/core/src/query/compile";
import { parseDsl } from "../packages/core/src/query/parser";
import { describeRegistry } from "../packages/core/src/registry";
import type { CompileCtx } from "../packages/core/src/registry";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const presetsDir = join(repoRoot, "presets");
const outPath = join(repoRoot, "docs", "catalog.md");

/** Category order and display names for the page. A preset outside this list is an error. */
const CATEGORIES: { id: string; label: string }[] = [
  { id: "gaps", label: "Gaps" },
  { id: "opening-range", label: "Opening range" },
  { id: "initial-balance", label: "Initial balance" },
  { id: "levels", label: "Prior levels" },
  { id: "session-shape", label: "Session shape" },
  { id: "streaks", label: "Streaks" },
  { id: "seasonality", label: "Seasonality" },
  { id: "events", label: "Events" },
  { id: "time-of-day", label: "Time of day" },
  { id: "volatility", label: "Volatility" },
  { id: "fvg", label: "Fair value gaps" },
];

/** Windows every default symbol config derives; used only to compile-check preset DSL. */
const VALIDATION_CTX: CompileCtx = { orWindows: [5, 10, 15, 30, 60], ibWindow: 60 };

/** Fill sample values for params without defaults so the composed DSL can be compile-checked. */
function sampleParams(preset: Preset): Record<string, number | string> {
  const params: Record<string, number | string> = {};
  for (const spec of preset.params) {
    if (spec.default !== undefined) continue;
    switch (spec.type) {
      case "number":
        params[spec.name] = 1;
        break;
      case "duration":
        params[spec.name] = 15;
        break;
      case "enum":
        params[spec.name] = spec.values?.[0] ?? "";
        break;
      case "string":
        params[spec.name] = "OPEX";
        break;
    }
  }
  return params;
}

function validate(presets: Preset[], groupable: Set<string>): void {
  const known = new Set(CATEGORIES.map((c) => c.id));
  for (const preset of presets) {
    if (!known.has(preset.category)) {
      throw new Error(`preset '${preset.id}': unknown category '${preset.category}'`);
    }
    if (preset.groupBy !== undefined && !groupable.has(preset.groupBy)) {
      throw new Error(
        `preset '${preset.id}': groupBy '${preset.groupBy}' is not a groupable field`,
      );
    }
    // Compose with defaults (+ sample values for default-less params) and compile
    // against the registry, so a bad outcome, predicate, field, or enum value in
    // any preset file fails generation instead of failing users at query time.
    const { dsl } = composePresetDsl(preset, sampleParams(preset));
    compileQuery(parseDsl(dsl), VALIDATION_CTX);
  }
}

/** First sentence of the summary — ends at the first '.' followed by whitespace and a capital. */
function firstSentence(text: string): string {
  const match = /^[\s\S]*?\.(?=\s+["'(A-Z0-9])/.exec(text);
  return match ? match[0] : text;
}

/** Markdown table cells must not contain raw pipes or newlines. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();
}

function paramCell(param: PresetParam): string {
  const kind = param.type === "enum" && param.values ? param.values.join("/") : param.type;
  const suffix = param.type === "duration" ? "m" : "";
  const def = param.default !== undefined ? `, default ${String(param.default)}${suffix}` : "";
  return `\`${param.name}\` (${kind}${def})`;
}

/**
 * Structural variant count for one preset: the preset itself, plus one variant
 * per allowed value of each enum parameter, plus one per registry-enumerated
 * value of its default grouping field (fields without enumerated values add none).
 */
function expandedVariants(preset: Preset, fieldEnumSizes: Map<string, number>): number {
  let count = 1;
  for (const param of preset.params) {
    if (param.type === "enum" && param.values) count += param.values.length;
  }
  if (preset.groupBy) count += fieldEnumSizes.get(preset.groupBy) ?? 0;
  return count;
}

async function main(): Promise<void> {
  const presets = loadPresets(presetsDir);
  if (presets.length === 0) throw new Error(`no presets found in ${presetsDir}`);

  const fieldDescriptions = describeRegistry("field");
  const groupable = new Set(fieldDescriptions.filter((f) => f.groupable).map((f) => f.name));
  const fieldEnumSizes = new Map(
    fieldDescriptions.map((f) => [f.name, f.enumValues ? f.enumValues.length : 0]),
  );

  validate(presets, groupable);

  const variantTotal = presets.reduce((sum, p) => sum + expandedVariants(p, fieldEnumSizes), 0);

  const lines: string[] = [];
  lines.push("# Preset catalog");
  lines.push("");
  lines.push(
    "Every preset is one versioned JSON query file in `presets/` — an outcome, optional base conditions, parameters that expand into query fragments, and original definition prose. Run one with `edgestats report <id> --symbol <SYM>` (add `--param key=value` or `--group <field>` to reshape it), and the result arrives as the engine's standard envelope: sample size, Wilson 95% confidence interval, minimum-sample guards, a first-half/second-half stability split, per-year counts, and — where the outcome carries one — a value distribution. Every summary below states its denominator and numerator; these are historical conditional frequencies, not forecasts. The catalog is a directory, so extending it is a pull request, not a feature request.",
  );
  lines.push("");

  for (const category of CATEGORIES) {
    const rows = presets.filter((p) => p.category === category.id);
    if (rows.length === 0) continue;
    lines.push(`## ${category.label}`);
    lines.push("");
    lines.push("| Preset | Title | What it measures | Params | Group by | Beyond a fixed report |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const p of rows) {
      const params = p.params.length > 0 ? p.params.map(paramCell).join("; ") : "—";
      const groupBy = p.groupBy ? `\`${p.groupBy}\`` : "—";
      lines.push(
        `| \`${p.id}\` | ${cell(p.title)} | ${cell(firstSentence(p.summary))} | ${cell(params)} | ${groupBy} | ${cell(p.deltas.join("; "))} |`,
      );
    }
    lines.push("");
  }

  const categoryCount = CATEGORIES.filter((c) => presets.some((p) => p.category === c.id)).length;
  lines.push(`**Total: ${presets.length} presets across ${categoryCount} categories.**`);
  lines.push("");
  lines.push(
    `**Expanded variants: ${variantTotal}.** Counted structurally from these files and the registry: each preset counts once, plus one variant per allowed value of each enum parameter, plus one per registry-enumerated value of its default grouping field. Numeric, duration, and string parameters — and the unlimited ad-hoc conditions every preset accepts — multiply the real space far beyond this number, while some counted combinations can be empty on a given dataset; treat it as a size of the named surface, not a claim about your data.`,
  );
  lines.push("");
  lines.push(
    "_This page is generated by `scripts/generate-catalog.ts` from `presets/` and the registry — do not edit it by hand. Regenerate with `pnpm run gen:catalog`._",
  );
  lines.push("");

  const prettierOptions = (await resolveConfig(outPath)) ?? {};
  const markdown = await format(lines.join("\n"), { ...prettierOptions, parser: "markdown" });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown);
  console.log(
    `docs/catalog.md: ${presets.length} presets, ${categoryCount} categories, ${variantTotal} expanded variants`,
  );
}

await main();
