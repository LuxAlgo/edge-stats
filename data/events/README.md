# Macro event calendars

Event dates ship as versioned JSON files so `eventDay('FOMC')`,
`dayBeforeEvent('CPI')`, and `dayAfterEvent('NFP')` are first-class query
predicates. Each file carries:

- `event` — the name queries use (`FOMC`, `CPI`, `NFP`, `OPEX`, …)
- `sources` — where the dates come from (rule or cited publication schedule)
- `coverage` — the horizon this file is good for; CI's freshness check reds
  as the horizon approaches
- `dates` — the dates themselves

## Files

| File        | Status | How it's built                                                                                                                                           |
| ----------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opex.json` | ✅     | Rule-generated (3rd Friday, holiday-shifted) by `scripts/gen-events.mjs`                                                                                 |
| `fomc.json` | ✅     | Statement day (second day) of each scheduled FOMC meeting, 2015–2026, from the Fed's published calendars; unscheduled/emergency meetings excluded        |
| `cpi.json`  | ✅     | Monthly CPI release dates, 2015 → 2026-09-11, from the BLS release schedule and dated archive filenames; the 2025 shutdown gap is real, not missing data |
| `nfp.json`  | ✅     | Employment Situation release dates, 2015 → 2026-09-04, from the BLS release schedule and dated archive filenames; irregular dates verified one by one    |

Not rule-derivable calendars (FOMC/CPI/NFP) are data, not code: they are
compiled from the issuing institution's published schedule, cite it in
`sources`, and get extended by pull request when the institution publishes
the next year. Do not hand-invent dates — a wrong event date silently
corrupts every query conditioned on it.

## Adding your own events

Drop any file matching the schema into your store's `events/` directory and
re-run `edgestats sync` — earnings dates, contract expiries, your own
journal tags. The predicate namespace is yours.
