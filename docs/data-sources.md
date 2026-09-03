# Data sources

Edge Stats computes on data **you** already have or license. Every adapter
writes the same shape into your local store: 1-minute bars with **UTC
epoch-millisecond timestamps** (whatever unit the vendor speaks — seconds,
ms, µs, ns — is normalized on the way in), synced incrementally from a
per-symbol watermark. Where a vendor needs credentials, they are **read
from environment variables at fetch time and never logged, never written
to disk, never sent anywhere except that vendor** — errors and docs only
ever mention the env var _names_. Keys stay on your box.

`edgestats adapters` lists everything below straight from the registry.

| Adapter       | Covers                                                                                | Cost model (the vendor's, not ours)                                                       | Env keys                             |
| ------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| `csv`         | Anything you can export to a file                                                     | —                                                                                         | —                                    |
| `synthetic`   | Deterministic demo bars                                                               | —                                                                                         | —                                    |
| `binance`     | Binance spot crypto, full 1m history                                                  | Free, keyless (public archives + public REST)                                             | —                                    |
| `coinbase`    | Coinbase Exchange crypto, 1m candles                                                  | Free, keyless (public endpoint, rate-limited)                                             | —                                    |
| `alpaca`      | US equities/ETFs, 1m bars (IEX free tier)                                             | Free tier for IEX feed; SIP per Alpaca's plans — check their pricing page                 | `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` |
| `databento`   | CME futures (GLBX.MDP3), continuous 1m                                                | Pay-as-you-go, metered per pull — **built-in cost preflight, capped**                     | `DATABENTO_API_KEY`                  |
| `massive`     | Massive flat files from disk                                                          | Per your Massive subscription — files you already downloaded cost nothing extra to import | `MASSIVE_API_KEY` (future REST only) |
| `lse`         | Stocks, FX, crypto, commodities, indices, ETFs, futures — deep multi-asset 1m history | Free, one free API key                                                                    | `LSE_API_KEY`                        |
| `dukascopy`   | FX, index CFDs, commodities, crypto — deep 1m history                                 | Free, keyless (public tick archive)                                                       | —                                    |
| `hyperliquid` | Hyperliquid perp crypto, live 1m tail                                                 | Free, keyless (venue retains ~5000 candles per interval)                                  | —                                    |
| IBKR          | _(planned — see below)_                                                               |                                                                                           |                                      |

All examples below are `symbols[]` entries for `edge-stats.config.json`.
After editing the config, `edgestats sync` pulls from each symbol's
watermark forward; `edgestats sync --full` re-pulls from scratch.

## csv — the universal escape hatch

If your data source can export a file, Edge Stats can compute on it:
vendor exports, TradingView downloads, your own recordings. Column names,
delimiter, and timestamp unit (`ms`/`s`/`iso`) are mapped in
`adapterOptions` — see the worked example in
`packages/core/src/adapters/csv.ts`, which documents the full mapping
shape. No keys, no network.

## binance — free, keyless crypto history

Deep spot history comes from Binance's public bulk archives
(`data.binance.vision`): whole months of 1-minute klines as ZIP'd CSVs,
then whole days for the stretch the monthly files haven't caught up to,
then the public REST klines endpoint for the live tail. No account, no
key, no cost. The adapter handles both archive vintages (older files carry
millisecond open times, newer ones microseconds and a header row) and
skips any month already behind your watermark.

```json
{
  "symbol": "BTCUSDT",
  "adapter": "binance",
  "assetClass": "crypto",
  "tf": "1m"
}
```

`adapterOptions.market` defaults to `"spot"` (the only market wired up
today). Two options exist for environments where `api.binance.com`
refuses the region with HTTP 451 (notably US-hosted CI runners) while the
archive CDN serves anywhere: `adapterOptions.start` (ISO date) bounds the
first sync without the REST listing probe, and
`adapterOptions.archiveOnly: true` skips the REST live tail, so history
simply ends at the newest published daily archive (about a day behind).

## coinbase — keyless crypto candles

The public Coinbase Exchange candles endpoint serves at most 300
one-minute candles per request, so the adapter walks 300-minute windows
forward from your watermark at a polite ~3 requests/second. That makes it
great for keeping a symbol fresh and slow for multi-year backfills — for
deep history, import a flat file once via `csv` and let `coinbase` take it
from there. The config symbol is the product id (e.g. `BTC-USD`).

```json
{
  "symbol": "BTC-USD",
  "adapter": "coinbase",
  "assetClass": "crypto",
  "tf": "1m"
}
```

`adapterOptions.start` (ISO date, default `2016-01-01`) bounds the first
sync when no watermark exists yet.

## alpaca — US equities/ETF minute bars

Alpaca Market Data v2 with your own key pair. The free tier serves the IEX
feed, which is what the adapter requests by default; set
`adapterOptions.feed` to `"sip"` only if your Alpaca data subscription
includes it (see Alpaca's own pricing page for terms). Export
`ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` in your shell — sync checks they
exist before fetching and sends them only as request headers to Alpaca.

```json
{
  "symbol": "SPY",
  "adapter": "alpaca",
  "assetClass": "equity",
  "tf": "1m",
  "adapterOptions": { "feed": "iex" }
}
```

`adapterOptions.start` (ISO date, default `2016-01-01`) bounds the first
sync.

## databento — CME futures, pay-as-you-go, with a spend cap

Databento meters historical pulls by the data actually delivered, so this
adapter treats your money as part of the contract:

1. **Every sync runs a mandatory cost preflight.** Before requesting any
   data it asks Databento's own `metadata.get_cost` for the exact range it
   is about to pull.
2. **If the vendor's estimate exceeds `adapterOptions.maxCostUsd`
   (default $5), the pull refuses** with the estimate and the range in the
   error. Raise the cap in config only when you mean to spend it. We never
   hardcode or guess a price — the number always comes from Databento's
   metering; check their pricing page for how it is computed.

Bars are requested as the volume-ranked continuous contract
(`ES` → `ES.v.0` on dataset `GLBX.MDP3`), and each row carries the raw
underlying contract (`ESH4`, `ESM4`, …) into the store's `contract`
column — that is what the engine's roll detection reads, so **a gap
across a roll day is a roll, not a gap** in every downstream statistic.

Export `DATABENTO_API_KEY`; it travels only as an auth header to
Databento.

```json
{
  "symbol": "ES",
  "adapter": "databento",
  "assetClass": "future",
  "tf": "1m",
  "adapterOptions": { "maxCostUsd": 5 }
}
```

`adapterOptions.dataset` defaults to `"GLBX.MDP3"`; `adapterOptions.start`
(default `2010-06-06`, the dataset's documented inception) bounds the
first sync — the cost preflight is what actually protects a large range.

## massive — flat files first

Massive distributes downloadable flat files of minute aggregates; this
adapter imports them straight from disk, which is the most local-first
path there is: download once with your subscription, compute forever.
Point `files` at a file or folder of `.csv` / `.csv.gz` (gzip inflated
in memory); whole-market files are filtered down to your configured
ticker, timestamp units are detected automatically, and files import in
name order (the vendor's date-stamped names already sort chronologically).
Cost: whatever your Massive subscription already covers — importing files
you have downloaded adds nothing.

```json
{
  "symbol": "SPY",
  "adapter": "massive",
  "assetClass": "equity",
  "tf": "1m",
  "adapterOptions": { "files": "data/massive/" }
}
```

A direct REST pull (behind `MASSIVE_API_KEY`) is a **documented TODO**:
the endpoint shape is still being verified, and the adapter says so
explicitly rather than guessing URLs. Flat files are the supported path
today.

## lse — free multi-asset history with one free key

The [London Strategic Edge](https://londonstrategicedge.com/data) vault
serves 1-minute candles across stocks, FX, crypto, commodities, indices,
ETFs, and futures — US stocks back to 2003, FX to 2009, crypto to 2017 —
behind a single free API key. This is the broadest free backfill source
Edge Stats has: one key covers asset classes that otherwise each need
their own vendor. The adapter pages 5000 candles per call forward from
your watermark. Export `LSE_API_KEY`; it travels only as an `x-api-key`
header to the vault.

```json
{
  "symbol": "EURUSD",
  "adapter": "lse",
  "assetClass": "fx",
  "tf": "1m",
  "adapterOptions": { "lseSymbol": "EUR/USD" }
}
```

`adapterOptions.lseSymbol` maps your store symbol to the vault's naming
(e.g. `EUR/USD`) when they differ; `adapterOptions.start` (default
`2009-01-01`) bounds the first sync; `adapterOptions.dataset` pins an
asset class when one symbol exists in several. FX candles carry no
consolidated volume, so volume-based fields are not meaningful on FX
synced from this source.

## dukascopy — keyless FX and CFD history

The public Dukascopy datafeed is a tick archive reaching back to the
2000s for major FX pairs, fetched and aggregated to 1-minute bars through
the MIT-licensed [`dukascopy-node`](https://www.dukascopy-node.app/)
library. No account, no key, no cost. The adapter pulls 7-day windows
forward from your watermark so multi-year backfills stay memory-bounded;
weekend windows legitimately return nothing.

Two honesty notes, because statistics are only as honest as their data
labels: volumes here are the feed's per-side tick volumes, not
consolidated market volume, and index or commodity symbols are
Dukascopy's CFD pricing of those markets, not exchange prints. Session
shape statistics are robust to both, but you should know what you are
looking at.

```json
{
  "symbol": "EURUSD",
  "adapter": "dukascopy",
  "assetClass": "fx",
  "tf": "1m"
}
```

`adapterOptions.instrument` (default: the store symbol lowercased) is the
dukascopy-node instrument id; `adapterOptions.start` (default
`2010-01-01`) bounds the first sync.

## hyperliquid — keyless perp crypto tail

Hyperliquid's public info endpoint serves 1-minute perp candles with no
key, but only the most recent ~5000 candles per interval — about 3.5 days
of minutes. This adapter is therefore a **tail source**: a daily
`edgestats sync` accumulates history forward from the day you start, and
it covers perp symbols no spot exchange lists. For deep 1m backfill use
`lse` or `binance` on the equivalent spot pair and let `hyperliquid` keep
the perp fresh.

```json
{
  "symbol": "BTC",
  "adapter": "hyperliquid",
  "assetClass": "crypto",
  "tf": "1m"
}
```

`adapterOptions.coin` maps your store symbol to the Hyperliquid coin name
when they differ.

## IBKR (planned)

An Interactive Brokers adapter slot is documented, not implemented, for people whose market
data entitlements already live with their broker: the intent is to pull
historical minute bars through IBKR's locally running gateway — so bars,
credentials, and entitlements all stay on your machine, consistent with
everything above. It is not implemented yet; no config shape is promised.
If this is your data source today, `csv` import of an IBKR export works
now.

## Operational notes

- **Watermarks.** Each (symbol, timeframe, adapter) remembers the last bar
  it stored; sync pulls strictly after it. `edgestats sync --full` drops a
  symbol's bars and re-pulls everything.
- **Timestamps.** Every stored bar timestamp is the bar's UTC open in
  epoch milliseconds, whatever the vendor's native unit or timezone.
- **Schema canaries.** A scheduled workflow
  (`.github/workflows/adapter-canaries.yml`) pulls a tiny recent sample
  from each vendor daily and fails loudly if a response shape drifts.
  Keyed canaries skip cleanly when no repo secret is configured; they are
  deliberately not PR gates.
- **Keys.** `requiresEnv` on each adapter is checked before any fetch, so
  a missing key fails fast with the exact env var names to export — and
  that is the only place key names appear. Key _values_ appear nowhere:
  not in URLs, not in logs, not in the store.
