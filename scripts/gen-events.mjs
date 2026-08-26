/*
  Generates data/events/opex.json — monthly equity options expiration
  (the 3rd Friday; the prior Thursday when the 3rd Friday is Good Friday
  or another full-market holiday under the deterministic rules).

  FOMC / CPI / NFP calendars are NOT rule-derivable — they ship as
  separately compiled data files with per-date citations (see
  data/events/README.md).
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addDays, goodFriday, iso, nthWeekday, observed, utc } from "./lib/market-dates.mjs";

const FROM_YEAR = 2010;
const TO_YEAR = 2027;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "data", "events");
mkdirSync(outDir, { recursive: true });

function fullHolidaySet(y) {
  const set = new Set();
  const add = (d) => {
    if (d !== null) set.add(iso(d));
  };
  add(observed(utc(y, 1, 1), { skipSaturday: true }));
  add(goodFriday(y));
  add(observed(utc(y, 7, 4)));
  add(observed(utc(y, 12, 25)));
  return set;
}

const dates = [];
for (let y = FROM_YEAR; y <= TO_YEAR; y += 1) {
  const holidays = fullHolidaySet(y);
  for (let m = 1; m <= 12; m += 1) {
    let d = nthWeekday(y, m, 5, 3);
    while (holidays.has(iso(d))) d = addDays(d, -1);
    dates.push(iso(d));
  }
}

const opex = {
  event: "OPEX",
  version: "2026-08.1",
  sources: [
    "Deterministic rule: 3rd Friday of each month; the prior business day when that Friday is a full US market holiday (OCC/Cboe listing conventions).",
  ],
  notes:
    "Monthly equity options expiration dates. Rule-generated; spot-check against the OCC/Cboe expiration calendar before extending coverage.",
  coverage: { from: `${FROM_YEAR}-01-01`, to: `${TO_YEAR}-12-31` },
  dates,
};

writeFileSync(join(outDir, "opex.json"), JSON.stringify(opex, null, 2) + "\n");
console.log(`wrote opex.json (${dates.length} dates) for ${FROM_YEAR}–${TO_YEAR}`);
