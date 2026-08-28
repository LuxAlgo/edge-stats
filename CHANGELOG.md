# Changelog

All notable changes to Edge Stats are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/).

## Unreleased

### Added

- Trade tags: `edgestats trades import` turns your own executed trades
  (read-only via `@luxalgo/broker-sdk`, or a broker statement CSV) into
  TRADED / TRADED_WIN / TRADED_LOSS event tags, day-assigned with the
  store's session calendars and classified by signed FIFO realized P&L.
- `eventOccurs(event)` outcome: any event calendar (macro or trade tags) as
  a rate under arbitrary conditions.
- `edge_trades` MCP tool reporting the store's trade tags.

### Changed

- Dashboard restyled onto the LuxAlgo data-canvas design system (Geist,
  black canvas, one validated chart hue, prism accent).

## 0.1.0 - 2026-08-26

Initial public release.

- Core engine: local DuckDB store with parquet bar partitions, calendar
  subsystem (IANA timezones, versioned holiday and half-day data,
  overnight sessions, roll-aware continuous futures), four-stage session
  feature derivation, a registry of fields, predicates, and outcomes, a
  string DSL with a typed JSON AST compiled to SQL, and a statistical
  honesty layer: N and a Wilson 95% CI on every result, minimum-sample
  guards, stability splits, recency views, distributions.
- `edgestats` CLI: init (with a zero-key synthetic demo), sync, query,
  report, presets, fields, adapters, export, calendar, freshness, serve,
  live, bench.
- Local dashboard: reports grid, per-report filter pages, a query builder
  with the live DSL string and reproducible permalinks, a Live Board, and
  a data freshness view.
- MCP server with eight read-only tools over stdio and streamable HTTP.
- Data adapters: CSV, deterministic synthetic demo, Binance, Coinbase,
  Alpaca, Databento (with a mandatory capped cost preflight), Massive
  flat files.
- Preset catalog: 42 presets across 11 categories, generated catalog page.
- Live Board: developing-session evaluation with historical conditional
  estimates, threshold alerts, five sinks, and replayable snapshots.
- Data: NYSE and CME calendars with sources and coverage horizons; OPEX,
  FOMC, CPI, and NFP event calendars compiled from official schedules.
- Maintenance machinery: CI quality gates, a zero-key demo smoke, a
  performance benchmark gate, daily adapter canaries, calendar freshness
  checks, Library citation parity checks, and generated-file drift checks.
