/*
  Build the nightly hosted artifacts (.github/workflows/hosted-store.yml):
  sync the hosted symbol list through the ordinary adapters, derive session
  features, run every preset through the real engine, and emit exactly
  three files for the rolling `hosted-store` GitHub release:

    out/manifest.json    what is hosted — symbols with coverage, the preset
                         catalog, engine version, build time and commit
    out/results.json     every preset × symbol result envelope, exactly as
                         the engine returned it (N, Wilson CI, guards,
                         stability split, per-year, distribution,
                         disclaimer), with session drill-down stripped
    out/derived.duckdb   the derived store (sessions/features/events/meta)

  Raw vendor bars are deliberately NOT published: bars live in parquet
  partitions outside the .duckdb file, so copying the .duckdb ships only
  session-level derived data. Symbols under `pendingTermsReview` in
  hosted-config.json stay out of the build until a human has read that
  vendor's redistribution terms and moved them to `enabled`.

  Runs anywhere: `pnpm exec tsx scripts/hosted/build-hosted-store.ts`.
  Symbols whose adapter needs env keys are skipped (with a log line) when
  the keys are absent, so a fork without secrets still builds.
*/
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ENGINE_VERSION,
  Store,
  configSchema,
  deriveFeatures,
  freshness,
  getAdapter,
  loadPresets,
  makeSessionResolver,
  presetsDir,
  runPreset,
  syncSymbols,
  type EdgeStatsConfig,
  type PresetRunResult,
} from "../../packages/core/src";

const repoRoot = resolve(import.meta.dirname, "../..");
const workDir = join(repoRoot, ".hosted-build");
const outDir = join(workDir, "out");
const dataDir = join(workDir, ".edge-stats");

interface HostedConfig {
  note: string;
  enabled: Record<string, unknown>[];
  pendingTermsReview: Record<string, unknown>[];
}

// HOSTED_CONFIG_PATH lets tests build from a stand-in symbol list (e.g. the
// synthetic adapter) without touching the published one.
const hostedConfigPath =
  process.env.HOSTED_CONFIG_PATH ?? join(repoRoot, "scripts/hosted/hosted-config.json");
const hosted = JSON.parse(readFileSync(hostedConfigPath, "utf8")) as HostedConfig;

// Keep only symbols whose adapter can actually run here (env keys present).
const runnable: Record<string, unknown>[] = [];
for (const entry of hosted.enabled) {
  const adapter = getAdapter(String(entry.adapter));
  const missing = adapter.requiresEnv.filter((v) => !process.env[v]?.trim());
  if (missing.length > 0) {
    console.log(`skip ${String(entry.symbol)}: missing env ${missing.join(", ")}`);
    continue;
  }
  runnable.push(entry);
}
if (runnable.length === 0) {
  console.error("no runnable hosted symbols — nothing to build");
  process.exit(1);
}

const config: EdgeStatsConfig = configSchema.parse({ dataDir, symbols: runnable });

rmSync(workDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
// Seed the packaged calendars, event files, and preset catalog, same as init.
cpSync(join(repoRoot, "data/holidays"), join(dataDir, "calendar"), { recursive: true });
cpSync(join(repoRoot, "data/events"), join(dataDir, "events"), { recursive: true });
cpSync(join(repoRoot, "presets"), join(dataDir, "presets"), { recursive: true });

const store = await Store.open(dataDir);
const log = (msg: string) => console.log(msg);

console.log(`syncing ${config.symbols.length} symbol(s)…`);
await syncSymbols(store, config, { log });

console.log("deriving session features…");
const resolver = makeSessionResolver(config, store.dataDir);
await deriveFeatures(store, config, resolver, { log });

const presets = loadPresets(presetsDir(dataDir));
console.log(`running ${presets.length} presets × ${config.symbols.length} symbols…`);

type HostedResult =
  | { preset: string; symbol: string; result: PresetRunResult }
  | { preset: string; symbol: string; error: string };

const results: HostedResult[] = [];
for (const symbolConfig of config.symbols) {
  for (const preset of presets) {
    try {
      const result = await runPreset(store, config, presets, {
        presetId: preset.id,
        symbol: symbolConfig.symbol,
        sessionsLimit: 0, // session drill-down is a local-store feature
      });
      results.push({ preset: preset.id, symbol: symbolConfig.symbol, result });
    } catch (err) {
      // A preset can be legitimately inapplicable to an asset class (e.g.
      // an event-calendar preset on a market with no such events). Record
      // the reason instead of failing the build.
      const message = err instanceof Error ? err.message : String(err);
      results.push({ preset: preset.id, symbol: symbolConfig.symbol, error: message });
      console.log(`  ${preset.id} × ${symbolConfig.symbol}: ${message}`);
    }
  }
}

const fresh = await freshness(store, config);
const coverage: Record<string, unknown>[] = [];
for (const s of config.symbols) {
  const rows = await store.all(
    `SELECT session_key,
            count(*)        AS sessions,
            min(trade_date) AS first_day,
            max(trade_date) AS last_day
     FROM session_features
     WHERE symbol = '${s.symbol.replaceAll("'", "''")}'
     GROUP BY session_key
     ORDER BY session_key`,
  );
  coverage.push({
    symbol: s.symbol,
    assetClass: s.assetClass,
    adapter: s.adapter,
    tf: s.tf,
    lastBar: fresh.symbols.find((f) => f.symbol === s.symbol)?.lastBar ?? null,
    sessions: rows.map((r) => ({
      sessionKey: String(r.session_key),
      sessions: Number(r.sessions),
      firstDay: String(r.first_day),
      lastDay: String(r.last_day),
    })),
  });
}

const manifest = {
  builtAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? "local",
  engineVersion: ENGINE_VERSION,
  calendarHash: fresh.calendarHash,
  storeFingerprint: fresh.storeFingerprint,
  symbols: coverage,
  presets: presets.map((p) => ({
    id: p.id,
    version: p.version,
    title: p.title,
    category: p.category,
    summary: p.summary,
    outcome: p.outcome,
    where: p.where ?? null,
    groupBy: p.groupBy ?? null,
    params: p.params,
  })),
  source: "https://github.com/LuxAlgo/edge-stats",
  note: "Derived session statistics only — no raw vendor bars are published. Results are historical conditional frequencies with sample sizes, not predictions.",
};

await store.close();

writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest) + "\n");
writeFileSync(join(outDir, "results.json"), JSON.stringify({ results }) + "\n");
cpSync(join(dataDir, "edge-stats.duckdb"), join(outDir, "derived.duckdb"));

for (const name of ["manifest.json", "results.json", "derived.duckdb"]) {
  const kb = Math.round(statSync(join(outDir, name)).size / 1024);
  console.log(`out/${name}  ${kb} KB`);
}
const failures = results.filter((r) => "error" in r).length;
console.log(`done: ${results.length - failures} results, ${failures} inapplicable preset runs`);
