# Session calendars

Every statistic in Edge Stats is a per-session statistic, so the definition
of "a session" is load-bearing. This page documents exactly how sessions
are resolved.

## The model

A session window is `(trade date, start wall-clock, end wall-clock, IANA
timezone, overnight?)`. Concrete UTC boundaries are computed through the
timezone database (via luxon), which is what makes DST transitions data
instead of arithmetic: the same `09:30` New York open is `14:30Z` in
January and `13:30Z` in July, and the engine's tests pin both sides of both
2024 transitions.

Built-in windows by asset class (all overridable per symbol in
`edge-stats.config.json` under `sessions`):

| Asset class | Key                                 | Window                                     |
| ----------- | ----------------------------------- | ------------------------------------------ |
| equity      | `rth`                               | 09:30–16:00 America/New_York               |
| future      | `rth`                               | 09:30–16:00 America/New_York               |
| future      | `globex`                            | 18:00 (prior day) – 17:00 America/New_York |
| crypto      | `utc`                               | 00:00–24:00 UTC, seven days a week         |
| crypto      | `ny`                                | 09:30–16:00 America/New_York               |
| forex       | `sydney`/`tokyo`/`london`/`newyork` | standard UTC windows, user-overridable     |

Features derive for **every** defined window, so `--session globex` and
`--session rth` are two complete, independent statistical universes over
the same bars.

## Overnight sessions and trade dates

An overnight session belongs to the trade date it settles on: Monday's
Globex session opens **Sunday 18:00 ET**. Gap features for a `globex`
session compare against the prior `globex` session's close; for `rth`,
against the prior `rth` close. Choose the universe that matches the
question.

## Holidays and half days

Holiday and half-day calendars are **versioned data files** in
`data/holidays/` (copied into each store at `edgestats init` so a store
always knows exactly which calendar it derived with — the calendar hash is
part of every result envelope). Each file carries sources, a version, and a
coverage horizon; CI regenerates them from `scripts/gen-holidays.mjs` and
fails on drift, and a freshness check reds as horizons approach.

- Holidays remove the trade date entirely.
- Half days truncate the session end to the published early close, and the
  session is flagged (`halfDay` is a queryable field — exclude or isolate
  shortened sessions explicitly).
- One-off closures (weather, mourning days) are explicit entries with
  names, not exceptions in code.

Known modeling choices, on purpose and documented in the data files
themselves: the CME calendar ships an equity-index profile (full closes on
New Year's/Good Friday/Christmas, 13:00 ET halts on the other US
holidays); product groups with materially different schedules need their
own calendar file. Exact halt minutes vary by product and year — verify
against the exchange before extending coverage.

## Completeness

A derived session is `complete` only when its bars actually cover the
window (first and last bar within a grace period of the boundaries).
Incomplete sessions — a developing live session, a partial vendor backfill,
a data hole — are excluded from every historical query by construction and
are visible in drill-downs. No statistic silently averages over holes.

## Checking your calendar

```bash
edgestats calendar --symbol SPY --from 2024-11-25 --to 2024-11-29
# 2024-11-25  …T14:30:00.000Z → …T21:00:00.000Z
# 2024-11-26  …
# 2024-11-27  …
# 2024-11-29  …T14:30:00.000Z → …T18:00:00.000Z HALF DAY   (Thanksgiving Friday)
edgestats freshness    # calendar versions + coverage horizons
```
