# The hosted derived store

Edge Stats is local-first: your bars, your store, your box. The hosted
derived store is the one deliberate exception, built so agents can ask
session-statistics questions with **zero setup** through the hosted
[LuxAlgo MCP server](https://github.com/LuxAlgo/luxalgo-mcp-server) — and
it publishes **derived session statistics only, never raw vendor bars**.

## How it works

A nightly workflow (`.github/workflows/hosted-store.yml`) runs the real
engine end to end on a GitHub runner:

1. Sync the hosted symbol list (`scripts/hosted/hosted-config.json`)
   through the ordinary adapters.
2. Derive session features, exactly as `edgestats sync` does locally.
3. Run the **full preset catalog** per symbol through `runPreset`, so
   every published number carries the same honesty envelope as a local
   run: N, Wilson 95% CI, minimum-sample guards, stability split,
   per-year counts, distributions, and the disclaimer.
4. Publish three assets to the rolling
   [`hosted-store` release](https://github.com/LuxAlgo/edge-stats/releases/tag/hosted-store),
   replaced every night:

| Asset            | Contents                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `manifest.json`  | Build time and commit, engine version, symbols with per-session coverage, the preset catalog       |
| `results.json`   | Every preset × symbol result envelope, verbatim from the engine, with session drill-down stripped  |
| `derived.duckdb` | The derived store itself (session features, events, meta) for anyone who wants to query it locally |

The assets are plain public release downloads; the hosted LuxAlgo MCP
server reads them, and so can you.

## What is published, and what never is

- **Published:** session-level derived rows (one row per symbol × session
  × trade date: session OHLC, gap and range features, event flags) and
  the precomputed result envelopes.
- **Never published:** raw minute bars. Bars live in parquet partitions
  outside the `.duckdb` file, and the workflow uploads only the
  `.duckdb` plus the two JSON files.
- **Symbol policy:** a symbol enters the build only from the `enabled`
  list in `scripts/hosted/hosted-config.json`. Entries under
  `pendingTermsReview` are wired and tested but stay out of the build
  until a human has read that vendor's redistribution terms and moved
  them to `enabled`. Vendor keys, where needed, come from repo secrets
  and travel only as request headers to their vendor.

## Consuming the artifacts

Download the derived store and query it with anything that speaks
DuckDB, or fetch the precomputed envelopes directly:

```bash
curl -LO https://github.com/LuxAlgo/edge-stats/releases/download/hosted-store/manifest.json
curl -LO https://github.com/LuxAlgo/edge-stats/releases/download/hosted-store/results.json
curl -LO https://github.com/LuxAlgo/edge-stats/releases/download/hosted-store/derived.duckdb
```

Every envelope in `results.json` is a `PresetRunResult` from
`@luxalgo/edge-stats-core` — the same shape the CLI's `--json` flag and
the local MCP server emit. Numbers without their sample size do not
exist here either.

## Adding a symbol

1. Add the entry to `enabled` in `scripts/hosted/hosted-config.json`
   (same shape as a `symbols[]` entry in `edge-stats.config.json`).
2. If the adapter needs keys, add the repo secret and expose it to the
   build step in `.github/workflows/hosted-store.yml` (the alpaca and
   lse lines show the pattern). Symbols whose keys are absent are
   skipped with a log line, never a failure.
3. If the vendor is new to the hosted list, put the entry under
   `pendingTermsReview` first and have a human read the vendor's terms.

## Testing the build locally

The build script accepts a stand-in symbol list, so the whole pipeline
(sync → derive → presets → artifacts) is testable offline with the
synthetic adapter:

```bash
HOSTED_CONFIG_PATH=path/to/stand-in.json pnpm exec tsx scripts/hosted/build-hosted-store.ts
```

Artifacts land in `.hosted-build/out/`.
