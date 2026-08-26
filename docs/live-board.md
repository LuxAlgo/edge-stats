# Live Board

The Live Board watches your queries against the session that is developing
right now and tells you — with sample sizes and confidence intervals —
what sessions like it did historically. When the historical estimate
crosses a threshold you set, it fires an alert through your sinks, and
every fired alert stores the full evaluation snapshot it came from.

## What the number means (read this first)

The probability the board shows is **not** computed from the developing
session, and it is **not** a forecast. It is the same historical
conditional estimate `edgestats query` would give you, over **complete
sessions only**, with history cut off **the day before** the developing
trade date — the session you are watching can never leak into its own
statistics.

The developing session is used for exactly one thing: deciding whether the
watch's conditions currently hold. Feature derivation writes a row for
in-progress sessions (flagged `complete = false`), so after a sync the
developing session's decision-time fields — gap direction, opening-range
state, prior-level position — are queryable like any other row, while the
row itself stays excluded from every historical count.

Each watch is always in one of three phases:

| Phase      | Meaning                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forming`  | A session is developing, but the WHERE conditions are not (or not yet) true. Conditions that depend on still-NULL features (the session is too young) read as forming. |
| `active`   | A session is developing and the conditions hold on it right now.                                                                                                       |
| `resolved` | No developing session contains the current time — the session ended, or the latest session is already complete.                                                        |

Every estimate carries N and the Wilson 95% CI, the minimum-N guards apply
exactly as they do everywhere else in the engine, and the disclaimer
travels with every rendered setup and every fired alert. Frequencies, not
forecasts.

## One evaluation pass

For every entry in `live.watch`, each tick:

1. **Resolve the query** — the raw `dsl`, or `preset` + `params` composed
   through the same preset engine as `edgestats report`.
2. **Find the developing session** — the latest `complete = false` feature
   row for (symbol, session key) whose `[start, end)` window contains the
   current time.
3. **Check the conditions** on that single row. True → `active`; false or
   NULL-dependent → `forming`; no developing session → `resolved`.
4. **Compute the estimate** by running the full query over complete
   sessions with `until` = the day before the developing trade date.
5. **Alert** when the phase is `active`, the estimate exists (not withheld
   by the refuse floor), it crosses the watch threshold, and the sample is
   at least `minN` (the config warn floor when unset). At most one alert
   fires per watch per trade date — the alerts table is the dedupe ledger.
6. **Publish state** — the board writes its state to the store under the
   `live_state` meta key on every pass (see "The state seam" below).

## Configuration

The board is configured with a `live` block in `edge-stats.config.json`:

| Field         | Type    | Default | Meaning                                                    |
| ------------- | ------- | ------- | ---------------------------------------------------------- |
| `enabled`     | boolean | `false` | Master switch for the `edgestats live` loop.               |
| `intervalSec` | number  | `300`   | Seconds between evaluation ticks (minimum 15).             |
| `watch`       | array   | `[]`    | The watch list — one entry per setup to track (see below). |
| `sinks`       | array   | `[]`    | Where fired alerts go (see below).                         |

Each `watch` entry:

| Field        | Type   | Required   | Meaning                                                                                                      |
| ------------ | ------ | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `dsl`        | string | one of     | A raw query, e.g. `"gapFill WHERE gapDir = down"`.                                                           |
| `preset`     | string | dsl/preset | A preset id from the catalog (e.g. `"gap-fill"`), instead of `dsl`.                                          |
| `params`     | object | no         | Preset parameters, same names as `edgestats report --param`.                                                 |
| `symbol`     | string | yes        | A configured symbol.                                                                                         |
| `sessionKey` | string | no         | Session window (defaults to the symbol's default session).                                                   |
| `threshold`  | object | no         | `{ "min": …, "max": … }` in `[0, 1]`. Alert fires when the estimate is `>= min` or `<= max` (inclusive).     |
| `minN`       | number | no         | Minimum matched historical sessions before this watch may alert. Defaults to the config's `minN.warn` floor. |

## Sinks

Secrets are configured by **environment variable name** — the config file
stores names, never values, and values are never logged.

| Sink       | Config                                                         | Setup                                                                                                                          |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `webhook`  | `{ "type": "webhook", "url": "…" }`                            | POSTs the full alert payload as JSON to your endpoint. 5-second timeout, one retry.                                            |
| `discord`  | `{ "type": "discord", "webhookUrlEnv": "…" }`                  | Set the named env var to a channel webhook URL. Sends one compact message with estimate, CI, N, the query, and the disclaimer. |
| `telegram` | `{ "type": "telegram", "botTokenEnv": "…", "chatIdEnv": "…" }` | Set the named env vars to your bot token and chat id. Same message discipline as discord.                                      |
| `ndjson`   | `{ "type": "ndjson", "path": "alerts.ndjson" }`                | Appends one JSON line per alert (the full payload). Parent directories are created. The machine-friendly tail for automation.  |
| `desktop`  | `{ "type": "desktop" }`                                        | Best-effort local notification (`notify-send` on Linux, `osascript` on macOS). Silently does nothing when unavailable.         |

A sink whose env vars are missing logs one clear warning (naming the
variable, never its value) and is skipped; it never stops the loop or the
other sinks.

## The alert payload (v1)

The webhook body, the NDJSON line, and the data behind every chat message.
Versioned so downstream automation can rely on it — new fields may be
added, existing fields will not change meaning within `v: 1`.

| Field              | Type                 | Meaning                                                                                                                                                   |
| ------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`                | `1`                  | Payload schema version.                                                                                                                                   |
| `kind`             | `"edge-stats.alert"` | Constant discriminator for mixed streams.                                                                                                                 |
| `id`               | string               | Deterministic: `symbol\|tradeDate\|hash(query + threshold)`. Same setup on the same trade date always produces the same id — this is also the dedupe key. |
| `firedAt`          | string (ISO 8601)    | When the alert fired.                                                                                                                                     |
| `symbol`           | string               | The watched symbol.                                                                                                                                       |
| `sessionKey`       | string               | The session window evaluated.                                                                                                                             |
| `tradeDate`        | string (ISO date)    | The developing session's trade date.                                                                                                                      |
| `dsl`              | string               | The normalized query the estimate answers.                                                                                                                |
| `estimate`         | number               | Historical conditional frequency, in `[0, 1]`.                                                                                                            |
| `ci95`             | `[number, number]`   | Wilson 95% confidence interval around the estimate.                                                                                                       |
| `n`                | number               | Matched historical sessions behind the estimate.                                                                                                          |
| `threshold`        | object               | The `{ min?, max? }` bounds that were crossed.                                                                                                            |
| `storeFingerprint` | string               | Deterministic receipt of the store contents the estimate was computed from.                                                                               |
| `disclaimer`       | string               | Travels with every alert: frequencies, not forecasts.                                                                                                     |

## Replay: no mystery numbers

Every fired alert is stored in the local store's `alerts` table together
with its full evaluation snapshot: the payload, the complete query result
envelope (N, CI, guards, stability split, per-year counts, matching
sessions), the watch that fired, and the evaluation instant.

```bash
edgestats live alerts              # list fired alerts (newest first)
edgestats live alerts --limit 10
edgestats live replay <id>         # re-print exactly what the board saw when it fired
```

If a notification ever surprises you, replay it — the number can always be
traced to the query, the data fingerprint, and the sessions behind it.

## The state seam

Every pass writes the board state to the store meta key `live_state`:

```json
{
  "enabled": true,
  "updatedAt": "2026-08-25T14:30:00.000Z",
  "setups": [
    {
      "id": "ES_FUT|2026-08-25|1f2e3d4c5b6a",
      "symbol": "ES_FUT",
      "sessionKey": "rth",
      "tradeDate": "2026-08-25",
      "dsl": "gapFill WHERE gapDir = down AND absGapPct >= 0.2",
      "phase": "active",
      "estimate": 0.74,
      "ci95": [0.66, 0.8],
      "n": 132,
      "lowSample": false,
      "evaluatedAt": "2026-08-25T14:30:00.000Z"
    }
  ]
}
```

`GET /api/live/state` on `edgestats serve` returns this object (or
`{ "enabled": false, "setups": [] }` when the board has never run), and the
MCP live tool reads the same seam. When the loop shuts down it rewrites the
state with `enabled: false`; when a tick's bar sync fails, the loop keeps
evaluating against the last synced data and the state carries a
`syncError` note so consumers can see the estimates are running on stale
bars. `updatedAt` always tells you how fresh the evaluation is.

## Running it

```bash
edgestats live            # sync + evaluate on the configured interval, until Ctrl+C
edgestats live --once     # one pass: print the setups table and exit
edgestats live --interval 60
edgestats live --no-sync  # evaluate the store as-is, skip the per-tick pull
```

`edgestats live` renders the setups table after every pass — symbol, trade
date, phase, estimate, 95% CI, N, and the query — with the low-sample
banner and the disclaimer, exactly like every other surface. A clean
shutdown (Ctrl+C) marks the published state disabled before exiting.

## Worked example: watching gap fills

Watch the gap-fill preset on down gaps, alert when the historical fill
rate is at least 70% with a real sample behind it, and fan alerts out to a
chat channel plus an NDJSON tail:

```json
{
  "live": {
    "enabled": true,
    "intervalSec": 300,
    "watch": [
      {
        "preset": "gap-fill",
        "params": { "dir": "down", "minGapPct": 0.2 },
        "symbol": "ES_FUT",
        "sessionKey": "rth",
        "threshold": { "min": 0.7 },
        "minN": 50
      }
    ],
    "sinks": [
      { "type": "discord", "webhookUrlEnv": "EDGESTATS_DISCORD_WEBHOOK" },
      { "type": "ndjson", "path": "alerts.ndjson" },
      { "type": "desktop" }
    ]
  }
}
```

```bash
export EDGESTATS_DISCORD_WEBHOOK="…your channel webhook URL…"
edgestats live
```

On a morning where the session gaps down at least 0.2%, the watch turns
`active`; if, say, 96 of 132 comparable historical sessions filled
(72.7%, 95% CI 64.6–79.6%), that crosses the 0.7 threshold with N = 132 ≥
50 and one alert fires — once for that trade date, no matter how many
ticks re-confirm it. The message reads:

> Edge Stats: ES_FUT 2026-08-25 (rth) — gapFill WHERE gapDir = down AND
> absGapPct >= 0.2 — estimate 72.7% (95% CI 64.6%–79.6%, N = 132) —
> historical frequency, not a forecast

What it does **not** say is "the gap will fill". The board reports what
comparable sessions did; whether that is tradable is a judgment the
numbers inform and never make.
