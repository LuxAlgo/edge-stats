/*
  Coinbase schema canary: one keyless candles request (≤ 300 minute bars)
  fingerprinting the shape the adapter depends on — array of ≥6-number
  rows, newest-first order, second-magnitude timestamps. Scheduled job;
  never a PR gate.
*/
import {
  coinbaseCandlesUrl,
  parseCoinbaseCandles,
} from "../../packages/core/src/adapters/coinbase";

function fail(msg: string): never {
  console.error(`DRIFT (coinbase): ${msg}`);
  process.exit(1);
}

const end = Date.now();
const url = coinbaseCandlesUrl("BTC-USD", end - 300 * 60_000, end);
const res = await fetch(url);
if (!res.ok) fail(`GET ${url} → HTTP ${res.status}`);

const payload: unknown = await res.json();
if (!Array.isArray(payload) || payload.length === 0) fail("expected a non-empty JSON array");
if (payload.length > 300) fail(`got ${payload.length} candles — the 300-per-call cap drifted`);

const first: unknown = payload[0];
if (!Array.isArray(first) || first.length < 6 || !first.every((v) => typeof v === "number")) {
  fail(`candle row is not ≥6 numbers: ${JSON.stringify(first).slice(0, 120)}`);
}
const firstTime = Number(first[0]);
if (firstTime > 1e11) fail(`candle time ${firstTime} is not epoch SECONDS — unit drifted`);

const last: unknown = payload[payload.length - 1];
if (Array.isArray(last) && Number(last[0]) > firstTime)
  fail("candles no longer arrive newest-first");

// The adapter's parser must produce sane ascending bars from the live shape.
const bars = parseCoinbaseCandles(payload, "BTC-USD", "1m");
const ascending = bars.every((b, i) => i === 0 || b.ts > (bars[i - 1]?.ts ?? Infinity));
if (!ascending) fail("parsed bars are not strictly ascending");
for (const b of bars.slice(0, 25)) {
  if (!(b.low <= b.open && b.low <= b.close && b.high >= b.open && b.high >= b.close)) {
    fail(`OHLC sanity failed — column order drifted? ${JSON.stringify(b)}`);
  }
}

console.log(`ok (coinbase): ${bars.length} candles, newest-first confirmed, sec→ms normalized`);
