# Continuous futures methodology

Session statistics on futures need a continuous series; every choice in how
you build one changes the numbers. This page is the engine's complete
stance, so nothing about a futures statistic is ever mysterious.

## The series

Edge Stats runs statistics on a **front-month continuous series stitched by
volume-style rolls**: bars carry the underlying `contract`, and the front
month is whatever the data source delivers for the continuous symbol (for
Databento, `<root>.v.0` — the volume-leading contract; for the synthetic
demo, a deterministic quarterly schedule). The engine does not construct
rolls itself — it **detects** them from the bar stream: a session whose
first contract differs from the prior session's last contract (or that
switches contract mid-session) is flagged `is_roll_day`.

## No back-adjustment. Ever.

Back-adjusting splices the price history so the roll gap disappears —
convenient for chart continuity, quietly catastrophic for gap statistics:
it manufactures or destroys opening gaps around every roll, and every
percentage computed against an adjusted price is off by the cumulative
adjustment.

Edge Stats keeps raw prices and instead makes roll days **structurally
inert** in the affected statistics:

- On a roll day, `gapPct`, `gapDir`, `gapFilled`, and every prior-session
  feature (`prevClose`, `prevHigh`, `touchedPrevHigh`,
  `openPosInPrevRange`, `insideDay`, …) are **NULL** — the prior session
  belongs to a different contract, so the question doesn't apply.
- Outcomes inherit this through their eligibility clauses: `gapFill`'s
  denominator is sessions with a gap, and a roll day has no gap by
  definition. **A gap across a roll is a roll, not a gap.**
- The day stays fully queryable: `rollDay` is a registry field, so
  `closeGreen WHERE rollDay` or `... AND NOT rollDay` are one predicate
  away, and drill-downs show the flag on every affected session.

## What still spans the roll

Return-based context features (`atrPct`, streak counters, NR4/NR7 range
comparisons, FVG zones) continue across rolls. The roll basis introduces a
small distortion into exactly one observation per quarter; we judge that
acceptable for context features and unacceptable for level-based features,
which is why the two classes are treated differently. If you disagree,
`NOT rollDay`-adjacent filtering and `edgestats export` give you the raw
material to do it your way.

## Verifying on your own store

```bash
edgestats query "closeGreen WHERE rollDay" --symbol ES        # the roll days themselves
edgestats export --table sessions --symbol ES --out es.csv    # audit every flag
```

The golden-session fixtures include a hand-built roll (contract H → M with
a basis jump) asserting all of the above — see
`fixtures/golden-sessions/` and the roll tests in
`packages/core/test/engine.test.ts`.
