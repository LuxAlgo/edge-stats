/*
  Alpaca schema canary: with keys configured, pull a tiny recent window of
  SPY 1m bars (free-tier IEX feed) and fingerprint the response shape the
  adapter depends on. Without keys the job exits 0. Scheduled; never a PR gate.
*/
import {
  alpacaBarsUrl,
  alpacaHeaders,
  parseAlpacaBars,
} from "../../packages/core/src/adapters/alpaca";

function fail(msg: string): never {
  console.error(`DRIFT (alpaca): ${msg}`);
  process.exit(1);
}

if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
  console.log(
    "skipped: no key configured (set ALPACA_KEY_ID / ALPACA_SECRET_KEY repo secrets to enable)",
  );
  process.exit(0);
}

// The last 7 full days always include at least one US trading day.
const end = new Date(Date.now() - 86_400_000).toISOString();
const start = new Date(Date.now() - 8 * 86_400_000).toISOString();
const url = alpacaBarsUrl("SPY", start, end, "iex", null);
const res = await fetch(url, { headers: alpacaHeaders(process.env) });
if (!res.ok) fail(`GET bars → HTTP ${res.status}`); // no URL in the log — params are pinned in code

const payload: unknown = await res.json();
if (typeof payload !== "object" || payload === null) fail("expected a JSON object");
const keys = Object.keys(payload as Record<string, unknown>).sort();
if (!keys.includes("bars")) fail(`response keys drifted: ${keys.join(", ")}`);
if (!keys.includes("next_page_token"))
  fail(`no next_page_token key — pagination shape drifted (keys: ${keys.join(", ")})`);

const page = parseAlpacaBars(payload, "SPY", "1m");
if (page.bars.length === 0) fail("zero SPY bars across 7 days — feed or shape drifted");

const raw = (payload as { bars: Record<string, unknown>[] }).bars[0] ?? {};
for (const field of ["t", "o", "h", "l", "c", "v"]) {
  if (!(field in raw))
    fail(`bar field '${field}' missing (fields: ${Object.keys(raw).join(", ")})`);
}
const firstBar = page.bars[0];
if (!firstBar || !Number.isFinite(firstBar.ts)) fail("RFC3339 't' no longer parses to epoch ms");

console.log(
  `ok (alpaca): ${page.bars.length} SPY bars, fields t/o/h/l/c/v present, pagination key present`,
);
