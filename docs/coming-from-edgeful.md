<!-- comparison facts last verified 2026-08-25 via public search extracts; re-verify before major releases -->

# Coming from Edgeful (or any report site)

This page is for traders who already think in reports — gap fill by
weekday, ORB 15, initial balance extensions — and want to know where each
one lives here. Edgeful is named nominatively as the best-known commercial
product in this category; everything below about their product comes from
public third-party material as of 2026-08 (this project never ingests
their site — see the README's Non-goals), and their product is theirs to
change. Everything about Edge Stats is verifiable in this repository.

Three things change conceptually when you switch:

1. **Fixed reports become one composable query engine.** A report site
   ships a menu: each report is a page, and each filter is a dropdown the
   vendor chose to build. Here, every report is one saved query —
   `P(outcome | conditions)` — over a shared registry of outcomes, fields,
   and predicates. The presets folder reproduces the familiar menu; the
   query language is what the menu was hiding.
2. **Bare percentages become honest envelopes.** Every number leaves this
   engine with its sample size, a Wilson 95% confidence interval,
   minimum-sample guards, a first-half/second-half stability split, and
   per-year counts. There is no code path that returns a percentage alone,
   so "78% on Tuesdays" arrives as an N you can judge and an interval you
   can doubt.
3. **Their servers become your disk.** Bars sync from your own data source
   into a local DuckDB store. No account, no telemetry, no history window
   that ends where a subscription tier says it does. If you stop using the
   project, the parquet and the database file are still yours.

## The report-to-preset map

Run any of these as `edgestats report <id> --symbol <SYM>`; every one
accepts `--param`, `--group`, and — the real upgrade — arbitrary extra
conditions when you take the echoed query and run it raw. Preset ids link
into the generated [catalog](catalog.md).

| The report you know                    | Preset id(s) here                                                                                        | What it gains here                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gap fill, by gap size                  | `gap-fill-by-size`                                                                                       | size buckets are a default view, not the ceiling — `absGapPct` gives any continuous cut; per-bucket N + 95% CI; time-to-fill distribution             |
| Gap fill, by weekday                   | `gap-fill-by-weekday`                                                                                    | one grouped result instead of five reports; per-weekday N + 95% CI expose which weekday effects are noise; direction/size filters stack               |
| Gap fill, by direction                 | `gap-fill-by-direction`                                                                                  | both directions share one denominator so the comparison can never disagree about N; any further condition applies to both rows at once                |
| Gap fill (plus fill-time, gap-and-go)  | `gap-fill`, `gap-fill-time`, `gap-and-go`, `gap-reversal`                                                | fill rate and fill clock arrive in one envelope; gap-and-go is the stated complement of fill, not a separate unreconciled number                      |
| Opening range breakout, 5/15/30        | `orb` (`window` is a duration parameter)                                                                 | any window — 5m, 15m, 30m, 7m if you want it; `orb-by-direction`, `orb-false-break`, `orb-time-to-break` are siblings on the same columns             |
| Opening range extensions / targets     | `orb-target` (`r` is continuous)                                                                         | the target ladder is yours, not a fixed 0.5/1/2 menu; the realized-extension distribution shows the whole curve in one query                          |
| Initial balance single/double/no-break | `initial-balance` (grouped by `ibBreakType`)                                                             | the N column doubles as the break-type frequency table — two classic reports in one result, each type with its own 95% CI                             |
| Initial balance extensions             | `ib-extension` (`r` is continuous)                                                                       | a continuous extension ladder with the conditional denominator (breaking sessions) stated, not implied                                                |
| Previous day's range / levels          | `prev-range`, `prev-high-touch-by-open`, `prev-low-touch`, `prev-high-break-hold`, `prev-low-break-hold` | open location is a continuous band, not an upper-half/lower-half toggle; minutes-to-touch distributions; touch vs. hold vs. reject on one definition  |
| Inside days                            | `inside-day` (and `outside-day`, its complement)                                                         | next-session return distribution attached, so direction and size are both visible; compose with NR4/NR7 to sharpen the compression                    |
| Engulfing candles                      | `engulfing-bull`, `engulfing-bear`                                                                       | an explicit, reproducible engulfing definition; the bull/bear pair mirrors exactly, so asymmetry is measurable; guards keep thin samples honest       |
| Event-day reaction (FOMC/CPI/NFP)      | `event-day-fomc`, `event-day-cpi`, `event-day-nfp`, `day-before-event`, `day-after-event`                | event calendars are versioned data files with cited official sources; `eventDay('FOMC')` also filters **every other** report, inclusion or exclusion  |
| Seasonality (weekday / month)          | `day-of-week`, `month-of-year`, `green-rate`                                                             | per-bucket N + 95% CI instead of a row of bare percentages; `green-rate` is the stated baseline every conditional number should be compared to        |
| Screener alerts                        | not a preset — the [Live Board](live-board.md) (`edgestats live`)                                        | watch any preset **or any raw query** with a threshold and a minimum-N floor; every fired alert stores its full evaluation snapshot and is replayable |

The deltas in the right column are the generated catalog's own `deltas`
fields — the same text `edge_reports_list` serves to agents.

## What you gain

- **Export.** `edgestats export` writes bars, derived sessions, event
  calendars, or the exact rows behind any query to CSV/parquet on your
  disk. Your analysis never dead-ends inside a web page.
- **Unlimited-by-your-source history.** The engine imposes no history
  window: full Binance archives, CME futures back to the dataset's 2010
  inception via Databento, or CSVs as deep as you have them.
- **Event conditioning everywhere.** FOMC/CPI/NFP/OPEX ship as versioned,
  cited calendars, and `eventDay`, `dayBeforeEvent`, `dayAfterEvent` are
  predicates on **every** outcome — not a separate report family. Drop
  your own event file in (earnings, expiries, journal tags) and it works
  identically.
- **MCP for agents.** A free local MCP server exposes nine tools —
  registry, query, sessions, presets, freshness, export, live — so your
  agents can answer "what actually happens after a down gap on CPI day?"
  with receipts.
- **CI'd calendars.** Holiday and half-day calendars are versioned data
  files with cited sources, regenerated and spot-checked in CI, and
  watched by a freshness check as coverage horizons approach.
- **Roll-aware futures correctness.** A gap across a futures roll is a
  roll, not a gap: roll days are flagged, excluded from gap and
  prior-level statistics by construction, and queryable explicitly
  (`rollDay`). See [continuous-futures.md](continuous-futures.md) for the
  full methodology, including why prices are never back-adjusted.

## What we deliberately don't do

- **No execution.** The engine answers questions; it never touches
  positions, brokers, or order routing.
- **No predictions.** Every number is a historical conditional frequency
  with its sample size — the disclaimer renders on every surface, and the
  Live Board's estimates are computed from complete past sessions only.
- **No hosted service.** There is no cloud, no account, and no tier. What
  you run is yours; the trade-off is that you run it.

## How the products compare

The comparison is nominative and factual. Edgeful's figures come from
public third-party reviews as of 2026-08 (daytradingz.com,
bullishbears.com), not from their site, which this project does not
ingest; treat their column as a snapshot and their website as the
authority. Every Edge Stats claim is verifiable in this repository.

|                             | Edgeful (as of 2026-08)                                         | Edge Stats                                                                           |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Model                       | Hosted web platform; computation on their servers               | Local engine; your bars, your DuckDB file, your disk                                 |
| Price                       | $49/mo (or $468/yr); algo and API tier at $299/mo; no free tier | MIT; you pay only your own data vendor                                               |
| Reports                     | 150+ pre-built reports                                          | 42 presets (121 named variants), plus any query you can compose                      |
| Filters                     | Per-report filter menus                                         | Every registry predicate composes with every outcome                                 |
| What travels with a number  | Report percentages; methodology presentation is theirs to state | N, Wilson 95% CI, minimum-sample guards, stability splits, enforced                  |
| History                     | 5+ years standard, 8 years top tier, per third-party reviews    | Your data source decides: full crypto history, CME futures depth, any CSV            |
| Tickers                     | 3,000+ assets on their hosted list                              | Whatever your source serves; CSV covers the rest                                     |
| Export                      | Not advertised in the public material we reviewed               | `edgestats export`: CSV or parquet of bars, sessions, events, or any query's matches |
| Programmatic access         | API access included with the $299/mo tier                       | Local MCP server (8 tools) and a local HTTP API                                      |
| Alerts                      | Screener and alerts across their main strategies                | Live Board: threshold and minimum-N alerts on any composed query, replayable         |
| Calendars and futures rolls | Not documented in the public material we reviewed               | Versioned, cited, CI-checked calendars; roll days excluded from gap stats            |
| License                     | Proprietary subscription                                        | MIT                                                                                  |

## The 60-second demo — zero keys, zero cost

```bash
git clone https://github.com/LuxAlgo/edge-stats && cd edge-stats
pnpm install
pnpm edgestats init --demo        # deterministic synthetic bars: ~900k bars, synced + derived in seconds
pnpm edgestats query "gapFill WHERE dayOfWeek = Tue" --symbol DEMO_STK
pnpm edgestats report gap-fill --symbol DEMO_FUT --group gapBucket
pnpm edgestats serve              # dashboard + API on localhost
```

Then point a symbol at your own data source
([docs/data-sources.md](data-sources.md)) and re-ask every question you
used to look up — this time with N, an interval, and the sessions behind
it.
