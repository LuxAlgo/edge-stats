# Trade tags: your own trades as query conditions

`edgestats trades import` turns your executed trades into three day
tags, stored as ordinary event files in your store:

- `TRADED`: trade dates with at least one imported fill
- `TRADED_WIN`: trade dates whose realized P&L was positive
- `TRADED_LOSS`: trade dates whose realized P&L was negative

Once imported, they behave exactly like the macro event calendars. Every
report, every preset, and any composed query can condition on your real
participation, and the `eventOccurs` outcome turns the tags into rates:

```bash
# Your realized day-win rate across every day you traded, with N and CI.
edgestats query "eventOccurs('TRADED_WIN') WHERE eventDay('TRADED')" --symbol ES

# The same day-win rate, only on NR7 sessions. Compare the two envelopes:
# the intervals, not the point estimates, decide if the difference is real.
edgestats query "eventOccurs('TRADED_WIN') WHERE eventDay('TRADED') AND prevNr7" --symbol ES

# How does the market's gap-fill rate look on days you chose to trade?
edgestats query "gapFill WHERE eventDay('TRADED')" --symbol ES
```

The point of the feature is that comparison: a setup's base rate next to
your realized performance on those same sessions, both wearing their
sample sizes and 95% confidence intervals.

## Importing

From a broker, read-only, through [`@luxalgo/broker-sdk`](https://github.com/LuxAlgo/broker-sdk):

```bash
export KRAKEN_API_KEY=... KRAKEN_API_SECRET=...
edgestats trades import --broker kraken
```

Credentials are read from environment variables named after the broker
and its credential fields (`kraken` + `apiSecret` becomes
`KRAKEN_API_SECRET`); a missing variable is reported by exact name along
with the broker's read-only setup guide. `edgestats trades` lists the
supported brokers. Keys are passed straight to the broker API call and
never stored, logged, or sent anywhere else.

From a broker statement export, no keys at all:

```bash
edgestats trades import --csv statement.csv
```

The statement needs symbol, side, quantity, and price columns (fee and
timestamp are used when present); common header spellings are recognized
automatically.

Two options cover the usual normalization gaps:

- `--map FROM=TO` maps broker symbols onto store symbols, e.g.
  `--map ESU6=ES` for a futures contract code against a continuous store
  symbol. Fills whose symbol matches no store symbol are skipped and
  counted, never guessed.
- `--mult SYM=N` sets a contract multiplier per store symbol, e.g.
  `--mult ES=50`. Multipliers only matter for the win/loss sign on days
  that mix symbols; within one symbol the sign is multiplier-invariant.

Re-importing overwrites the previous trade tags. `edgestats trades`
shows what is currently imported.

## What the tags mean, exactly

- **Day assignment.** A fill belongs to the first session window that
  ends after it, computed with the store's own session calendars. That
  places a pre-market equity fill on that day's session and a Sunday
  23:00 UTC Globex fill on Monday's trade date, with one rule. Fills
  without timestamps, after every known session, or on unmapped symbols
  are skipped and reported.
- **Realized P&L.** Signed FIFO per symbol: buys and sells both open
  lots, an opposite-side fill closes the oldest lots first, and a close
  realizes `(exit - entry) * quantity * multiplier`, net of both fills'
  proportional fees, on the closing fill's trade date. Shorts work the
  same way in reverse. Positions that never close realize nothing, so an
  open-only day is `TRADED` but neither win nor loss.
- **Honesty carries over.** Tag-conditioned queries go through the
  same engine as everything else: N and the Wilson 95% CI on every
  estimate, minimum-sample guards (your first weeks of trading WILL be
  refused as too small, which is the feature working), stability splits,
  and the sessions behind every number.

## Read-only, stated plainly

The import path uses only broker-sdk's read-only surface (accounts and
trade history). Nothing in Edge Stats imports the SDK's experimental
order-placement module, and nothing here can place, modify, or cancel an
order. See the Non-goals section of the README: no order execution,
ever.

## For agents

The MCP server's `edge_trades` tool reports which trade tags the store
carries and how to use them; the queries themselves run through
`edge_query` like any other. Agents cannot trigger an import: creating
or refreshing trade tags is a CLI action by the user, on purpose.
