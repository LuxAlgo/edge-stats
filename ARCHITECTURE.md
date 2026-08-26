# Architecture

Edge Stats is a local-first trading-statistics engine. It pulls intraday
bars from the user's own data source into a local database, derives
per-session features once, and answers composable conditional-probability
queries — `P(outcome | conditions)` — interactively, with sample sizes and
confidence intervals attached to every number. One machine, no accounts,
no telemetry.

```
packages/
  core/               @luxalgo/edge-stats — the engine
    src/
      adapters/       data in: csv, synthetic (+ vendor adapters)
      calendar/       exchange sessions, DST, holidays, half days
      features/       bars → one wide row per (symbol, session, window)
      registry/       fields + predicates + outcomes — single source of truth
      query/          DSL ⇄ AST → DuckDB SQL → honest envelope; export
      stats/          Wilson CI, min-N guards, stability, distributions
      store/          DuckDB file + hive-partitioned parquet bars
      live/           Live Board contracts (evaluation engine sits here)
      config.ts       zod-validated edge-stats.config.json
      events.ts       macro event calendars (FOMC/CPI/NFP/OPEX/…)
      sync.ts         adapters → store → derive orchestration
  cli/                @luxalgo/edge-stats-cli — edgestats
  mcp/                @luxalgo/edge-stats-mcp — edge_* tools, stdio + HTTP
  web/                the local dashboard (served by `edgestats serve`)
presets/              the report catalog: one versioned query file each
data/holidays/        exchange calendars (versioned data, cited sources)
data/events/          macro event dates (versioned data, cited sources)
fixtures/             golden sessions with hand-computed statistics
scripts/              calendar/event/fixture generators, catalog tooling
```

## The one-sentence data flow

**Adapters** fetch bars → the **store** appends them to parquet partitions
and remembers watermarks → **derive** joins bars to **calendar**-resolved
session windows and writes one wide `session_features` row per session →
**queries** compile registry expressions to SQL over that table → every
result leaves through the **stats** layer as an honest envelope.

## Core design decisions

### Derive once, query forever

Feature derivation (gap state, opening-range breaks per window, prior-level
touches, streaks, patterns, FVG state, event flags) runs at sync time, in
four stages: per-session SQL aggregates, level-dependent SQL scans, a
cross-session TypeScript pass for stateful features, and a final
parameterized scan for things like time-to-fill. Queries then run against a
few thousand wide rows — which is why a composed query over years of
1-minute bars answers in ~20ms, and why the query language can stay
declarative.

Bars live in hive-partitioned parquet (`symbol=/tf=/year=`) behind a DuckDB
view; sessions, features, watermarks, events, and alert snapshots live in
the DuckDB file. Everything is on the user's disk; `edgestats export` hands
any of it back out as CSV or parquet.

### The registry is the single source of truth

Every **field** (comparable value), **predicate** (composable condition),
and **outcome** (measured event) is declared exactly once, in
`core/src/registry/`, with its type, argument spec, definition prose,
examples, and — where it mirrors a concept in the LuxAlgo Library — the
canonical citation URL. From that one declaration flow:

- DSL name resolution and validation (with did-you-mean suggestions)
- SQL compilation
- `edgestats fields`
- the MCP tools' self-description
- the dashboard's filter and builder UIs
- the generated docs catalog

A predicate that is not in the registry does not exist. This is the
mechanism that makes "every filter works on every report" true by
construction rather than by effort.

### Outcomes are conditional by construction

An outcome declares an **eligibility** expression (the denominator: which
sessions the question even applies to) and a **success** expression (the
numerator), plus an optional continuous **value** (time-to-fill, extension
size) reported as a distribution. `gapFill` is
`P(filled | session gapped)`, not `P(filled)` — the difference between a
statistic and a slogan.

### DSL ⇄ AST → SQL

The string DSL (`gapFill WHERE dayOfWeek = Tue AND gapPct BETWEEN 0.2% AND
0.6% AND NOT eventDay('FOMC')`) parses to a zod-typed JSON AST — the
canonical form agents and the dashboard produce directly. The AST compiles
to DuckDB SQL against `session_features`. Round-trips are tested; every
result echoes its normalized query so a mis-parse is visible immediately.
Parse errors carry exact positions; name errors carry suggestions.

Conditions coalesce SQL NULLs to false, so `NOT x` is a true complement
over eligible sessions rather than three-valued-logic quicksand.

### The statistical honesty layer

Non-negotiable, engine-enforced:

- **N and the Wilson 95% CI on every estimate** — there is no bare-percentage
  code path.
- **Minimum-N guards**: below the warn floor (default 30) results carry a
  LOW SAMPLE banner; below the refuse floor (default 10) the estimate is
  withheld (counts still shown; `--force` reveals it, banner intact).
- **Stability split**: first half vs second half of the matched sessions,
  with an agreement flag (CI overlap).
- **Recency view**: the last-K-sessions estimate next to all-history, with
  a divergence flag.
- **Per-year counts** on every result.
- The **disclaimer renders wherever results render**: frequencies, not
  forecasts.

### The session calendar is a first-class subsystem

Session windows are computed from exchange-local wall-clock definitions
through the IANA timezone database (luxon), so DST transitions come from
tzdata, not hand-rolled offsets. Holidays and half-days are **versioned
data files** with cited sources and coverage horizons — regenerated by
`scripts/gen-holidays.mjs`, spot-checked in CI, and watched by a freshness
check as horizons approach. Overnight sessions (Globex 18:00 → 17:00 ET)
belong to their settlement trade date; Monday's session opens Sunday
evening.

**A gap across a futures roll is a roll, not a gap.** Roll days are
detected from the bar stream's contract column, flagged on the session, and
excluded from gap and prior-level features by construction — queryable
explicitly via the `rollDay` field, never silently blended in.

### Presets are query files

`presets/*.json` each hold an outcome, base conditions, parameter specs
that expand into DSL fragments, original definition prose, and Library
citations. The CLI, dashboard, MCP server, and generated catalog all
enumerate the same folder. A "report catalog" is a directory anyone can
extend by pull request.

### Everything speaks the same envelope

The CLI renderer, the local HTTP API (`edgestats serve`), the dashboard,
and the MCP tools all consume the identical `QueryResult` envelope from
core. Fixing a number in one place fixes it everywhere; there is exactly
one implementation of every statistic.

## Testing

- **Golden sessions**: a hand-designed fixture market
  (`fixtures/golden-sessions/`) where every gap, fill, break, touch,
  streak, and pattern was computed by hand; the derivation pipeline must
  reproduce the ledger exactly and the query layer must reproduce the
  hand-counted Ns.
- **Calendar edge cases**: DST transitions (both directions), holidays,
  half days, overnight boundaries, 24/7 weeks, roll days.
- **Statistics**: Wilson intervals against textbook values and closed
  forms, guard boundaries, stability agreement.
- **DSL**: round-trips, precedence, positions, suggestions, unit safety.
- **Determinism**: same store + same query ⇒ byte-identical envelope; the
  synthetic demo is seeded so goldens and benchmarks reproduce anywhere.
- **Performance**: `edgestats bench` gates interactivity in CI.

## Non-goals

Order execution, broker connections, real-time tick streaming, hosted
multi-tenant deployments, predictions, and trade advice are all out of
scope — deliberately and permanently. The engine computes historical
conditional frequencies on data the user already licenses, and says so
wherever numbers appear.
