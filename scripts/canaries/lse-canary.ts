/*
  LSE schema canary: with a key configured, one candles request (≤ 60
  minute bars of BTC/USD) fingerprinting the shape the adapter depends
  on — an array of row objects with a bar-open time and
  open/high/low/close. Without a key the job exits 0. Scheduled job;
  never a PR gate.
*/
import { lseCandlesUrl, parseLseCandles } from "../../packages/core/src/adapters/lse";

function fail(msg: string): never {
  console.error(`DRIFT (lse): ${msg}`);
  process.exit(1);
}

const apiKey = process.env.LSE_API_KEY;
if (apiKey === undefined || apiKey === "") {
  console.log("skipped: no key configured (set the LSE_API_KEY repo secret to enable)");
  process.exit(0);
}

const end = Date.now();
const url = lseCandlesUrl("BTC/USD", end - 60 * 60_000, end);
const res = await fetch(url, { headers: { "x-api-key": apiKey } });
if (!res.ok) fail(`GET ${url} → HTTP ${res.status}`);

const payload: unknown = await res.json();
if (!Array.isArray(payload) || payload.length === 0) fail("expected a non-empty JSON array");
if (payload.length > 5000) fail(`got ${payload.length} rows — the 5000-per-call cap drifted`);

const first: unknown = payload[0];
if (first === null || typeof first !== "object" || Array.isArray(first)) {
  fail(`candle row is not an object: ${JSON.stringify(first).slice(0, 120)}`);
}
const row = first as Record<string, unknown>;
if (row.ts === undefined && row.timestamp === undefined) {
  fail(`candle row carries neither ts nor timestamp: ${JSON.stringify(row).slice(0, 160)}`);
}
for (const field of ["open", "high", "low", "close"]) {
  if (!Number.isFinite(Number(row[field]))) fail(`candle row ${field} is not numeric`);
}

// The adapter's parser must produce sane ascending bars from the live shape.
const bars = parseLseCandles(payload, "BTC/USD", "1m");
const ascending = bars.every((b, i) => i === 0 || b.ts > (bars[i - 1]?.ts ?? Infinity));
if (!ascending) fail("parsed bars are not strictly ascending");
const ageMin = (Date.now() - (bars[bars.length - 1]?.ts ?? 0)) / 60_000;
if (ageMin > 24 * 60) fail(`freshest BTC/USD bar is ${Math.round(ageMin)} minutes old`);

console.log(`ok: lse served ${bars.length} sane 1m bars for BTC/USD`);
