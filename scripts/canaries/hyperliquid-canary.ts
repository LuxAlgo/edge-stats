/*
  Hyperliquid schema canary: one keyless candleSnapshot request (≤ 60
  minute bars of BTC) fingerprinting the shape the adapter depends on —
  an array of {t,o,h,l,c,v} objects with millisecond bar-open times.
  Scheduled job; never a PR gate.
*/
import {
  hyperliquidCandleBody,
  parseHyperliquidCandles,
} from "../../packages/core/src/adapters/hyperliquid";

function fail(msg: string): never {
  console.error(`DRIFT (hyperliquid): ${msg}`);
  process.exit(1);
}

const end = Date.now();
const res = await fetch("https://api.hyperliquid.xyz/info", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: hyperliquidCandleBody("BTC", end - 60 * 60_000, end),
});
if (!res.ok) fail(`POST candleSnapshot → HTTP ${res.status}`);

const payload: unknown = await res.json();
if (!Array.isArray(payload) || payload.length === 0) fail("expected a non-empty JSON array");

const first: unknown = payload[0];
if (first === null || typeof first !== "object" || Array.isArray(first)) {
  fail(`candle is not an object: ${JSON.stringify(first).slice(0, 120)}`);
}
const row = first as Record<string, unknown>;
const t = Number(row.t);
if (!Number.isFinite(t)) fail("candle t is not numeric");
if (t < 1e12 || t > 1e14) fail(`candle t ${t} is not epoch MILLISECONDS — unit drifted`);
for (const field of ["o", "h", "l", "c", "v"]) {
  if (!Number.isFinite(Number(row[field]))) fail(`candle ${field} is not numeric`);
}

// The adapter's parser must produce sane ascending bars from the live shape.
const bars = parseHyperliquidCandles(payload, "BTC", "1m");
const ascending = bars.every((b, i) => i === 0 || b.ts > (bars[i - 1]?.ts ?? Infinity));
if (!ascending) fail("parsed bars are not strictly ascending");
const ageMin = (Date.now() - (bars[bars.length - 1]?.ts ?? 0)) / 60_000;
if (ageMin > 30) fail(`freshest BTC bar is ${Math.round(ageMin)} minutes old`);

console.log(`ok: hyperliquid served ${bars.length} sane 1m bars for BTC`);
