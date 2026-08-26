/*
  Generates data/holidays/nyse.json and data/holidays/cme.json from
  published exchange rules (2010–2027), with explicit one-off closures.

  These files are DATA, reviewed like data: rule-generated, then verified
  against the exchanges' published calendars before release. CI's
  calendar-freshness check reds as the coverage horizon approaches;
  regenerate with a wider range and re-verify to extend it.
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addDays,
  goodFriday,
  iso,
  lastWeekday,
  nthWeekday,
  observed,
  utc,
  weekdayUtc,
} from "./lib/market-dates.mjs";

const FROM_YEAR = 2010;
const TO_YEAR = 2027;
const VERSION = "2026-08.1";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "data", "holidays");
mkdirSync(outDir, { recursive: true });

function push(list, date, name) {
  if (date !== null) list.push({ date: iso(date), name });
}

function nyseYear(y) {
  const holidays = [];
  const halfDays = [];

  push(holidays, observed(utc(y, 1, 1), { skipSaturday: true }), "New Year's Day");
  push(holidays, nthWeekday(y, 1, 1, 3), "Martin Luther King, Jr. Day");
  push(holidays, nthWeekday(y, 2, 1, 3), "Washington's Birthday");
  push(holidays, goodFriday(y), "Good Friday");
  push(holidays, lastWeekday(y, 5, 1), "Memorial Day");
  if (y >= 2022) push(holidays, observed(utc(y, 6, 19)), "Juneteenth National Independence Day");
  push(holidays, observed(utc(y, 7, 4)), "Independence Day");
  push(holidays, nthWeekday(y, 9, 1, 1), "Labor Day");
  const thanksgiving = nthWeekday(y, 11, 4, 4);
  push(holidays, thanksgiving, "Thanksgiving Day");
  push(holidays, observed(utc(y, 12, 25)), "Christmas Day");

  const jul3 = utc(y, 7, 3);
  if (weekdayUtc(jul3) <= 4) {
    halfDays.push({ date: iso(jul3), name: "Day before Independence Day", close: "13:00" });
  }
  halfDays.push({
    date: iso(addDays(thanksgiving, 1)),
    name: "Day after Thanksgiving",
    close: "13:00",
  });
  const dec24 = utc(y, 12, 24);
  if (weekdayUtc(dec24) <= 4) {
    halfDays.push({ date: iso(dec24), name: "Christmas Eve", close: "13:00" });
  }
  return { holidays, halfDays };
}

function cmeYear(y) {
  // CME equity-index products: full closures are New Year's, Good Friday,
  // and Christmas; other US holidays trade a shortened session with an
  // early halt (modeled at 13:00 ET; some products differ by minutes).
  const holidays = [];
  const halfDays = [];
  const early = (date, name) => {
    if (date !== null) halfDays.push({ date: iso(date), name, close: "13:00" });
  };

  push(holidays, observed(utc(y, 1, 1), { skipSaturday: true }), "New Year's Day");
  push(holidays, goodFriday(y), "Good Friday");
  push(holidays, observed(utc(y, 12, 25)), "Christmas Day");

  early(nthWeekday(y, 1, 1, 3), "Martin Luther King, Jr. Day (early halt)");
  early(nthWeekday(y, 2, 1, 3), "Washington's Birthday (early halt)");
  early(lastWeekday(y, 5, 1), "Memorial Day (early halt)");
  if (y >= 2022) early(observed(utc(y, 6, 19)), "Juneteenth (early halt)");
  const jul3 = utc(y, 7, 3);
  if (weekdayUtc(jul3) <= 4) early(jul3, "Day before Independence Day (early halt)");
  early(observed(utc(y, 7, 4)), "Independence Day (early halt)");
  early(nthWeekday(y, 9, 1, 1), "Labor Day (early halt)");
  const thanksgiving = nthWeekday(y, 11, 4, 4);
  early(thanksgiving, "Thanksgiving Day (early halt)");
  early(addDays(thanksgiving, 1), "Day after Thanksgiving (early halt)");
  const dec24 = utc(y, 12, 24);
  if (weekdayUtc(dec24) <= 4) early(dec24, "Christmas Eve (early halt)");
  return { holidays, halfDays };
}

function build(exchange, perYear, oneOffs, notes, sources) {
  const holidays = [];
  const halfDays = [];
  for (let y = FROM_YEAR; y <= TO_YEAR; y += 1) {
    const { holidays: h, halfDays: hd } = perYear(y);
    holidays.push(...h);
    halfDays.push(...hd);
  }
  holidays.push(...oneOffs);
  holidays.sort((a, b) => a.date.localeCompare(b.date));
  const holidaySet = new Set(holidays.map((h) => h.date));
  const filteredHalf = halfDays
    .filter((h) => !holidaySet.has(h.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    exchange,
    version: VERSION,
    sources,
    notes,
    coverage: { from: `${FROM_YEAR}-01-01`, to: `${TO_YEAR}-12-31` },
    holidays,
    halfDays: filteredHalf,
  };
}

const nyse = build(
  "NYSE",
  nyseYear,
  [
    { date: "2012-10-29", name: "Hurricane Sandy closure" },
    { date: "2012-10-30", name: "Hurricane Sandy closure" },
    { date: "2018-12-05", name: "National Day of Mourning (George H. W. Bush)" },
    { date: "2025-01-09", name: "National Day of Mourning (Jimmy Carter)" },
  ],
  "Rule-generated from the published NYSE holiday schedule with explicit one-off closures. Verify against the exchange calendar before extending coverage.",
  ["https://www.nyse.com/markets/hours-calendars"],
);

const cme = build(
  "CME",
  cmeYear,
  [],
  "CME equity-index profile: full closes on New Year’s Day, Good Friday, and Christmas; other US holidays modeled as 13:00 ET early halts (exact halt minutes vary by product and year — verify against the CME holiday calendar before extending coverage). Product groups with materially different schedules (energy, ags) need their own calendar file.",
  ["https://www.cmegroup.com/tools-information/holiday-calendar.html"],
);

writeFileSync(join(outDir, "nyse.json"), JSON.stringify(nyse, null, 2) + "\n");
writeFileSync(join(outDir, "cme.json"), JSON.stringify(cme, null, 2) + "\n");
console.log(
  `wrote nyse.json (${nyse.holidays.length} holidays, ${nyse.halfDays.length} half days), ` +
    `cme.json (${cme.holidays.length} holidays, ${cme.halfDays.length} half days) for ${FROM_YEAR}–${TO_YEAR}`,
);
