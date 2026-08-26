/*
  Binance schema canary: pull ONE recent daily 1m archive (keyless, tiny)
  and run it through the adapter's own parsers. Fails loudly on drift —
  column count, timestamp unit, OHLC sanity. Scheduled job; never a PR gate.
*/
import {
  binanceDailyUrl,
  parseBinanceKlineCsv,
  unzipBinanceKlines,
} from "../../packages/core/src/adapters/binance";

function fail(msg: string): never {
  console.error(`DRIFT (binance): ${msg}`);
  process.exit(1);
}

// Archives publish with ~a day of lag — T-2 is reliably there.
const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
const url = binanceDailyUrl("spot", "BTCUSDT", day);
const res = await fetch(url);
if (!res.ok) fail(`GET ${url} → HTTP ${res.status}`);

const csv = unzipBinanceKlines(new Uint8Array(await res.arrayBuffer()));
const firstRow = csv.split("\n").find((l) => /^\d/.test(l)) ?? "";
const columns = firstRow.split(",").length;
if (columns < 6) fail(`kline row has ${columns} columns, expected ≥ 6: ${firstRow.slice(0, 120)}`);

const bars = parseBinanceKlineCsv(csv, "BTCUSDT", "1m");
if (bars.length < 100) fail(`only ${bars.length} bars in the ${day} archive`);

// Unit-normalized timestamps must land inside the requested UTC day.
const dayStart = Date.parse(`${day}T00:00:00Z`);
const outside = bars.filter((b) => b.ts < dayStart || b.ts >= dayStart + 86_400_000);
if (outside.length > 0) fail(`${outside.length} bars normalized outside ${day} — ts unit drifted?`);

for (const b of bars.slice(0, 25)) {
  if (!(b.low <= b.open && b.low <= b.close && b.high >= b.open && b.high >= b.close)) {
    fail(`OHLC sanity failed — column order drifted? ${JSON.stringify(b)}`);
  }
}

console.log(
  `ok (binance): ${day} daily archive — ${bars.length} bars, ${columns} columns, unit normalized`,
);
