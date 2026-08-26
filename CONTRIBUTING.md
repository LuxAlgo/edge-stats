# Contributing

The fastest ways to make Edge Stats better, in rough order of leverage:

1. **A preset** — one JSON file in `presets/`. An outcome, conditions,
   params, and definition prose. If you can write the query, you can ship
   the report.
2. **A predicate or outcome** — one registry entry in
   `packages/core/src/registry/` (+ derivation columns if it needs new
   features, + golden fixtures). The DSL, docs, CLI, MCP, and dashboard
   pick it up automatically.
3. **An adapter** — `packages/core/src/adapters/`, registered in
   `adapters/index.ts`. Fetch bars, respect the watermark, never log keys.
4. **Calendar and event data** — versioned JSON with cited sources and
   coverage horizons. Extend the generators, never hand-edit generated
   output.

## Ground rules

- **Statistical honesty is not reviewable away.** Every estimate keeps its
  N, CI, and guards. PRs that surface a bare percentage anywhere — code,
  docs, screenshots — get changes requested.
- **Session-calendar correctness over feature count.** A wrong holiday is
  worse than a missing feature. Calendar changes need sources.
- **No lookahead.** Decision-time features (streaks, ATR, FVG state)
  describe strictly-prior sessions; intra-session conditioning is fine but
  must be obvious from the name and doc.
- **Determinism.** Same store + same query ⇒ identical result. Anything
  seeded stays seeded.
- **Golden fixtures move only with justification.** Any engine change that
  shifts a pinned number must explain why in the PR — "the old number was
  wrong because …" or it doesn't merge.
- **Clean room.** Never scrape, fetch, or ingest anything from other
  products' sites or apps; never reproduce their copy, visuals, or feature
  branding. We implement generic, public-domain trading math from public
  definitions, better.
- No telemetry, no phoning home, no accounts. Not even "anonymous".

## Sign-off (DCO)

Every commit needs a Developer Certificate of Origin sign-off: commit with
`git commit -s`, which adds the `Signed-off-by` trailer. CI checks it on
every pull request.

## Quality gates (CI runs exactly these)

```bash
pnpm format:check
pnpm lint --max-warnings 0
pnpm typecheck && pnpm --filter @luxalgo/edge-stats-web typecheck
pnpm test:run
pnpm edgestats --dir .ci-demo init --demo --quiet && pnpm edgestats --dir .ci-demo bench
```

Regenerated data (`data/holidays`, `data/events`, golden CSVs) must match
its generators — CI diffs them.

## Adding a registry entry, end to end

1. Declare it in `registry/fields.ts`, `predicates.ts`, or `outcomes.ts` —
   name, docs, args, SQL. Cite the Library concept if one exists.
2. If it needs new derived columns: add them to `features/schema.ts`, fill
   them in `features/derive.ts`, and extend the golden ledger in
   `fixtures/golden-sessions/` (hand-compute the expected values — that's
   the point).
3. `pnpm test:run` — the registry uniqueness check, DSL round-trips, and
   goldens will tell you what you missed.
4. Add an example to the entry's `examples` so the docs and MCP teach it.
