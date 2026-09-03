<p align="center">
  <img src="docs/media/banner.png" alt="Edge Stats" width="920">
</p>

<p align="center">
  Ask how often a trading setup actually worked, on your own market data.<br>
  Every answer is one query, <code>P(outcome | conditions)</code>, with the sample size and confidence interval attached.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="docs/catalog.md">Catalog</a> ·
  <a href="docs/data-sources.md">Data sources</a> ·
  <a href="#mcp">MCP</a> ·
  <a href="ARCHITECTURE.md">Architecture</a>
</p>

<p align="center">
  <a href="https://github.com/LuxAlgo/edge-stats/actions/workflows/ci.yml"><img src="https://github.com/LuxAlgo/edge-stats/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/LuxAlgo/edge-stats/actions/workflows/adapter-canaries.yml"><img src="https://github.com/LuxAlgo/edge-stats/actions/workflows/adapter-canaries.yml/badge.svg" alt="adapter canaries"></a>
  <a href="https://github.com/LuxAlgo/edge-stats/actions/workflows/calendar-freshness.yml"><img src="https://github.com/LuxAlgo/edge-stats/actions/workflows/calendar-freshness.yml/badge.svg" alt="calendar freshness"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4f7cff" alt="MIT license"></a>
</p>

Edge Stats is a [LuxAlgo](https://www.luxalgo.com) open source project. Official repository: [github.com/LuxAlgo/edge-stats](https://github.com/LuxAlgo/edge-stats).

---

Edge Stats answers questions like: how often did a Tuesday gap fill, and how long did the fill take? It syncs intraday bars from your own data source into a local DuckDB store, derives session features once, and then runs any question you can compose as a query. Any outcome in the registry combines with any set of conditions, so the report catalog is simply a folder of preset queries. It ships as a CLI, a local dashboard, and an MCP server; all three run the same engine and return the same result envelope.

```
$ edgestats query "gapFill WHERE dayOfWeek = Tue AND gapPct BETWEEN 0.05% AND 0.6%" --symbol DEMO_STK

gapFill WHERE dayOfWeek = Tue AND gapPct BETWEEN 0.05% AND 0.6%
  DEMO_STK · rth · start → latest

  estimate 80.0%   N = 30   95% CI [62.7%, 90.5%]   (24 hits)
  stability: 86.7% (n=15) vs 73.3% (n=15) · halves agree ✓
  distribution (minutes, n=24): median 3 · p25 0 · p75 31 · p90 157
  per-year: 2023 88.2% (17) · 2024 69.2% (13)

  Historical conditional frequencies with sample sizes. Not predictions, not advice.
```

## Quickstart

The demo store is deterministic synthetic data; no keys, no external services.

```bash
git clone https://github.com/LuxAlgo/edge-stats && cd edge-stats
pnpm install
pnpm edgestats init --demo        # ~900k synthetic bars, derived in seconds
pnpm edgestats query "gapFill WHERE dayOfWeek = Tue" --symbol DEMO_STK
pnpm edgestats report gap-fill --symbol DEMO_FUT --group gapBucket
pnpm edgestats serve              # dashboard + API on localhost
```

For real data, `edgestats adapters` lists every source and the env keys each one reads. Keys are read from your environment and never logged or sent anywhere else.

## Dashboard

<p align="center">
  <img src="docs/media/report.png" alt="Gap-fill report: estimate with N and 95% CI, stability split, per-year counts, and the time-to-fill distribution" width="920">
</p>

<p align="center">
  <img src="docs/media/dashboard.png" alt="Reports grid; each card shows its sample size and interval" width="460">
  <img src="docs/media/builder.png" alt="Query builder with the live DSL string" width="460">
</p>

Report cards, a query builder that shows the live DSL string, per-report filter pages, a live board, and drill-down from any number to the sessions behind it. The full query is encoded in the URL, so any view can be shared and reproduced.

## Statistical honesty

Every result carries the same envelope, in the CLI, the dashboard, the API, and over MCP:

- the point estimate with N and a Wilson 95% confidence interval
- minimum-sample guards: a warning below 30 sessions, no estimate below 10
- a first-half vs second-half stability split, and a recency view (last 250 sessions vs full history)
- per-year counts, and the value distribution for continuous outcomes
- the normalized query echoed back, with drill-down to the matching sessions
- a fixed disclaimer: historical frequencies, not predictions

There is no code path that prints a percentage without its sample size.

## Session calendars

Session boundaries are computed in exchange time through the IANA timezone database, and DST transitions are covered by test fixtures. Holiday and half-day calendars are versioned data files with cited sources and coverage horizons checked by CI. Overnight futures sessions settle on the correct trade date, and futures roll days are flagged and excluded from gap statistics by construction. Details in [docs/session-calendars.md](docs/session-calendars.md) and [docs/continuous-futures.md](docs/continuous-futures.md).

## Data sources

Edge Stats computes on data you already have or license. Every adapter normalizes into the same local store; [docs/data-sources.md](docs/data-sources.md) documents each path.

| Adapter       | Covers                                                  | Vendor cost                            | Env keys                             |
| ------------- | ------------------------------------------------------- | -------------------------------------- | ------------------------------------ |
| `csv`         | Anything you can export to a file                       | none                                   | none                                 |
| `synthetic`   | Deterministic demo bars                                 | none                                   | none                                 |
| `binance`     | Binance spot crypto, full 1m history                    | free, keyless                          | none                                 |
| `coinbase`    | Coinbase Exchange crypto, 1m candles                    | free, keyless                          | none                                 |
| `alpaca`      | US equities and ETFs, 1m bars                           | free tier (IEX feed)                   | `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` |
| `databento`   | CME futures, continuous 1m                              | pay as you go, with a capped preflight | `DATABENTO_API_KEY`                  |
| `massive`     | Massive flat files from disk                            | covered by your existing subscription  | none for flat files                  |
| `lse`         | Stocks, FX, crypto, commodities, indices, ETFs, futures | free, one free key                     | `LSE_API_KEY`                        |
| `dukascopy`   | FX, index CFDs, commodities, crypto                     | free, keyless                          | none                                 |
| `hyperliquid` | Hyperliquid perp crypto, live tail                      | free, keyless                          | none                                 |

The `csv` adapter covers anything not listed: if your source can export a file, Edge Stats can compute on it. A daily [adapter-canaries](.github/workflows/adapter-canaries.yml) workflow pulls a small sample from each vendor and fails on schema drift.

## Your trades

Import your own executed trades (read-only, through [broker-sdk](https://github.com/LuxAlgo/broker-sdk) or a statement CSV) and every query can condition on your real participation:

```bash
edgestats trades import --broker kraken         # or: --csv statement.csv
edgestats query "eventOccurs('TRADED_WIN') WHERE eventDay('TRADED') AND prevNr7" --symbol ES
```

That second line is your realized day-win rate on NR7 sessions, with its N and 95% CI, next to which the unconditioned rate is one query away. Setup base rates and your own execution finally share an envelope. Details, conventions, and the exact win/loss definition: [docs/trades.md](docs/trades.md).

## MCP

`@luxalgo/edge-stats-mcp` (stdio and streamable HTTP) exposes the engine to agents through nine read-only tools:

| Tool                | Returns                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `edge_freshness`    | Configured symbols, last bar per symbol, calendar versions            |
| `edge_fields`       | The registry: every outcome, predicate, and field, with definitions   |
| `edge_query`        | Any composed P(outcome given conditions), in the full envelope        |
| `edge_report`       | A preset from the catalog, with parameters                            |
| `edge_reports_list` | The catalog, with parameter specs                                     |
| `edge_sessions`     | The historical sessions behind a result                               |
| `edge_live`         | Live Board state: forming, active, and resolved setups                |
| `edge_trades`       | Which trade tags your imported trades produced, and how to query them |
| `edge_export`       | CSV or parquet written locally, path returned                         |

Typical flow: `edge_freshness`, then `edge_fields`, then `edge_query`, then `edge_sessions` for the underlying sessions.

This local server exists because your store lives on your disk, where no hosted service can reach. For zero-setup access, a nightly workflow publishes a hosted derived store (session statistics only, never raw bars) that the main LuxAlgo MCP serves as hosted `edge_*` tools; [docs/hosted-store.md](docs/hosted-store.md) documents what is published and how to consume it directly.

## Presets

A preset is one JSON file: an outcome, base conditions, parameters, and definition prose with citations into the [LuxAlgo Library](https://www.luxalgo.com/library/). The generated [catalog](docs/catalog.md) lists 42 presets across 11 categories (121 named variants), and anything the query language can express works without one. Adding a report is a pull request with one file.

Coming from a report site? [docs/coming-from-edgeful.md](docs/coming-from-edgeful.md) maps the classic session-statistics reports to their preset ids.

## Non-goals

- No order execution, ever. The optional trades import uses read-only broker access to read your own trade history; nothing here can place, modify, or cancel an order.
- No tick streaming; session statistics need bars.
- No hosted service, no telemetry, no accounts.
- No scraping of any other product's site or app. The statistics here are generic, well-known trading math, implemented independently from public definitions.
- No predictions and no advice: historical conditional frequencies with sample sizes.

## Development

```bash
pnpm install
pnpm test:run        # golden sessions, calendar edge cases, DSL, stats: 196 tests
pnpm typecheck && pnpm --filter @luxalgo/edge-stats-web typecheck
pnpm lint --max-warnings 0
pnpm edgestats --dir .ci-demo init --demo && pnpm edgestats --dir .ci-demo bench
```

[ARCHITECTURE.md](ARCHITECTURE.md) covers the system design. [CONTRIBUTING.md](CONTRIBUTING.md) covers adding presets, predicates, and adapters, and the review ground rules.

## License

Code is [MIT](LICENSE). The calendar and event data files under `data/` are additionally usable under [CC BY 4.0](DATA_LICENSE) with attribution to LuxAlgo. The dashboard bundles the Geist fonts under the [SIL OFL 1.1](packages/web/public/fonts/OFL.txt). See [TRADEMARKS.md](TRADEMARKS.md) for name and logo use, and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
