/*
  Dukascopy canary: pull yesterday's EURUSD minute bars through
  dukascopy-node (the exact path the adapter uses) and check the shape and
  sanity of what comes back. Weekends step back to Friday so the window
  always has ticks. Scheduled job; never a PR gate.
*/
import {
  defaultDukascopyFetcher,
  parseDukascopyRows,
} from "../../packages/core/src/adapters/dukascopy";

function fail(msg: string): never {
  console.error(`DRIFT (dukascopy): ${msg}`);
  process.exit(1);
}

// The most recent full weekday window (UTC): weekends have no FX ticks.
const day = new Date();
day.setUTCDate(day.getUTCDate() - 1);
while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8, 0));
const to = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 10, 0));

// Through the adapter's own fetcher, so the canary exercises the exact
// production path (and dukascopy-node resolves from packages/core, the
// package that declares it — a root import would not resolve under pnpm).
const rows: unknown = await defaultDukascopyFetcher({ instrument: "eurusd", from, to });

if (!Array.isArray(rows) || rows.length === 0) {
  fail(`expected minute rows for ${from.toISOString()}..${to.toISOString()}, got none`);
}
if (rows.length > 130)
  fail(`got ${rows.length} rows for a 120-minute window — aggregation drifted`);

// The adapter's parser must produce sane ascending bars from the live shape.
const bars = parseDukascopyRows(rows, "EURUSD", "1m");
const ascending = bars.every((b, i) => i === 0 || b.ts > (bars[i - 1]?.ts ?? Infinity));
if (!ascending) fail("parsed bars are not strictly ascending");
for (const b of bars) {
  if (!(b.low <= b.open && b.low <= b.close && b.high >= b.open && b.high >= b.close)) {
    fail(`bar at ${new Date(b.ts).toISOString()} violates low<=open,close<=high`);
  }
  if (b.open < 0.5 || b.open > 2.5) fail(`EURUSD open ${b.open} is out of any sane range`);
}

console.log(`ok: dukascopy served ${bars.length} sane 1m bars for EURUSD`);
