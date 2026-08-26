/*
  Databento schema canary: with a key configured, fingerprint the cost
  preflight (always) and — only when the vendor's own estimate for ONE
  hour of ES.v.0 ohlcv-1m is ≤ $0.01 — the get_range CSV header too.
  Without a key the job exits 0. Pay-as-you-go: this script is built to
  spend at most a cent. Scheduled; never a PR gate.
*/
import {
  databentoAuthHeader,
  databentoCostUrl,
  databentoRangeUrl,
  parseDatabentoCost,
  parseDatabentoOhlcvCsv,
  type DatabentoRange,
} from "../../packages/core/src/adapters/databento";

function fail(msg: string): never {
  console.error(`DRIFT (databento): ${msg}`);
  process.exit(1);
}

if (!process.env.DATABENTO_API_KEY) {
  console.log("skipped: no key configured (set the DATABENTO_API_KEY repo secret to enable)");
  process.exit(0);
}
const headers = databentoAuthHeader(process.env);

// One hour, three days back, aligned to 14:00 UTC — deep inside a Globex
// session on weekdays; a quiet weekend hour only shrinks the sample.
const startMs = Math.floor((Date.now() - 3 * 86_400_000) / 3_600_000) * 3_600_000;
const start = new Date(startMs).toISOString();
const end = new Date(startMs + 3_600_000).toISOString();
const range: DatabentoRange = {
  dataset: "GLBX.MDP3",
  symbolRoot: "ES",
  startIso: start,
  endIso: end,
};

const costRes = await fetch(databentoCostUrl(range), { headers });
if (!costRes.ok) fail(`metadata.get_cost → HTTP ${costRes.status}`);
const cost = parseDatabentoCost(await costRes.text()); // throws loudly on shape drift
console.log(
  `ok (databento): cost preflight answered $${cost.toFixed(6)} for 1h of ES.v.0 ohlcv-1m`,
);

if (cost > 0.01) {
  console.log(
    `skipping the data pull: estimate $${cost.toFixed(4)} > $0.01 canary budget (pricing is the vendor's)`,
  );
  process.exit(0);
}

const res = await fetch(databentoRangeUrl(range), { headers });
if (!res.ok) fail(`timeseries.get_range → HTTP ${res.status}`);
const csv = await res.text();
const header = (csv.split("\n")[0] ?? "").trim();
for (const column of ["ts_event", "open", "high", "low", "close", "volume", "symbol"]) {
  if (
    !header
      .split(",")
      .map((h) => h.trim())
      .includes(column)
  ) {
    fail(`ohlcv-1m CSV header lost '${column}' (header: ${header})`);
  }
}
const bars = parseDatabentoOhlcvCsv(csv, "ES", "1m");
const contract = bars[0]?.contract;
if (bars.length > 0 && (contract === null || contract === undefined)) {
  fail(
    "map_symbols no longer yields a raw contract in the 'symbol' column — roll detection would break",
  );
}
console.log(
  `ok (databento): get_range header intact, ${bars.length} bars, contract ${contract ?? "n/a (closed hour)"}`,
);
