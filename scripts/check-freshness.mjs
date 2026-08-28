/*
  Coverage-horizon freshness check for the calendar and event data files.

  Scans data/holidays/*.json and data/events/*.json — any set of files; new
  calendars are picked up automatically — prints each file's declared
  coverage horizon (`coverage.to`) and the days remaining from today, and
  exits 1 when a horizon is within --min-days (default 45) or already
  past, naming the file and how to extend it:

  - data/holidays/*: regenerate with a wider year range via
    scripts/gen-holidays.mjs (pnpm run gen:holidays), then re-verify
    against the exchange's published calendar.
  - data/events/*: rule-generated calendars via scripts/gen-events.mjs
    (pnpm run gen:events); compiled calendars follow the
    data/events/README.md process (cite the issuing institution's
    published schedule — never hand-invent dates).

  Each file's dated entries are also validated against its own claim: an
  entry dated BEYOND `coverage.to` is data outside the declared horizon and
  an error. The reverse — a horizon extending past the last entry — is
  fine: `coverage.to` is a validity claim, not a count of entries.

  Run with:  pnpm run check:freshness
  (or: node scripts/check-freshness.mjs [--min-days N] [--events-warn-only])

  Severity: a stale HOLIDAY calendar breaks session resolution itself, so
  it always fails. A stale EVENT calendar only shrinks eventDay() coverage,
  so with --events-warn-only its horizon prints as a warning instead of
  failing — that is what the PR-side CI gate uses, because a PR author
  cannot extend a data horizon that needs institutional verification.
  Structural problems (invalid JSON, entries beyond the declared coverage)
  are always hard errors. The scheduled calendar-freshness workflow runs
  fully strict: its badge going red IS the maintenance signal.
*/
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIRS = ["data/holidays", "data/events"];
const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/*
  45, not 120: BLS and the Fed publish exact dates on rolling schedules,
  and each year's full calendar lands in the prior autumn. A 120-day
  window is guaranteed to false-alarm every late summer, when the
  verified horizon (the published remainder of the current year) sits
  90-120 days out. 45 days still leaves weeks to run the documented
  extension procedure in data/events/README.md, and every monthly BLS
  release announces the next one, so the horizon never collapses
  silently.
*/
const DEFAULT_MIN_DAYS = 45;

function parseArgs(argv) {
  let minDays = DEFAULT_MIN_DAYS;
  let eventsWarnOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    let value;
    if (argv[i] === "--events-warn-only") {
      eventsWarnOnly = true;
      continue;
    } else if (argv[i] === "--min-days") value = argv[(i += 1)];
    else if (argv[i].startsWith("--min-days=")) value = argv[i].slice("--min-days=".length);
    else {
      console.error(
        `unknown argument: ${argv[i]} (usage: check-freshness.mjs [--min-days N] [--events-warn-only])`,
      );
      process.exit(1);
    }
    minDays = Number(value);
    if (!Number.isInteger(minDays) || minDays < 0) {
      console.error(`--min-days expects a non-negative integer, got: ${String(value)}`);
      process.exit(1);
    }
  }
  return { minDays, eventsWarnOnly };
}

/** Every date-bearing entry in the file's top-level arrays: plain ISO strings
    (events `dates`) and objects with an ISO `date` (holidays, half days). */
function entryDates(data) {
  const dates = [];
  for (const value of Object.values(data)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && ISO_DATE.test(item)) dates.push(item);
      else if (item !== null && typeof item === "object" && typeof item.date === "string") {
        if (ISO_DATE.test(item.date)) dates.push(item.date);
      }
    }
  }
  return dates;
}

function extensionHint(file) {
  if (file.startsWith("data/holidays/")) {
    return "regenerate with a wider year range via scripts/gen-holidays.mjs (pnpm run gen:holidays), then re-verify against the exchange's published calendar";
  }
  return "extend it — rule-generated calendars via scripts/gen-events.mjs (pnpm run gen:events); compiled calendars via the data/events/README.md process (cite the issuing institution's published schedule)";
}

const { minDays, eventsWarnOnly } = parseArgs(process.argv.slice(2));
const todayMs = new Date().setUTCHours(0, 0, 0, 0);
const today = new Date(todayMs).toISOString().slice(0, 10);

const files = DATA_DIRS.flatMap((dir) => {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => name.endsWith(".json"))
    .map((name) => `${dir}/${name}`);
}).sort();

if (files.length === 0) {
  console.error(`no data files found under ${DATA_DIRS.join(", ")} — nothing to check`);
  process.exit(1);
}

const rows = [];
const problems = [];
const warnings = [];

/** Horizon staleness on an events file is demotable; everything else is not. */
function pushHorizonProblem(file, message) {
  if (eventsWarnOnly && file.startsWith("data/events/")) warnings.push(message);
  else problems.push(message);
}

for (const file of files) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(repoRoot, file), "utf8"));
  } catch (err) {
    problems.push(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    rows.push({ file, label: "—", to: "invalid", days: "—" });
    continue;
  }

  const label = data.event ?? data.exchange ?? "—";
  const to = data.coverage?.to;
  if (typeof to !== "string" || !ISO_DATE.test(to)) {
    problems.push(`${file}: missing or malformed coverage.to (expected an ISO date)`);
    rows.push({ file, label, to: "missing", days: "—" });
    continue;
  }

  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - todayMs) / DAY_MS);
  rows.push({ file, label, to, days });

  const maxEntry = entryDates(data).reduce((max, d) => (d > max ? d : max), "");
  if (maxEntry !== "" && maxEntry > to) {
    problems.push(
      `${file}: contains an entry dated ${maxEntry}, beyond its declared coverage.to ${to} — ` +
        `data outside the declared horizon; widen coverage.to to cover every entry (or drop the stray entries)`,
    );
  }

  if (days < 0) {
    pushHorizonProblem(
      file,
      `${file}: coverage horizon ${to} is already past (${-days} days ago) — ${extensionHint(file)}`,
    );
  } else if (days < minDays) {
    pushHorizonProblem(
      file,
      `${file}: coverage horizon ${to} is only ${days} days away (threshold ${minDays}) — ${extensionHint(file)}`,
    );
  }
}

// Table: deterministic ordering (rows follow the sorted file list).
const header = { file: "file", label: "event/exchange", to: "coverage.to", days: "days remaining" };
const all = [header, ...rows.map((r) => ({ ...r, days: String(r.days) }))];
const width = (key) => Math.max(...all.map((r) => r[key].length));
for (const r of all) {
  console.log(
    `${r.file.padEnd(width("file"))}  ${r.label.padEnd(width("label"))}  ` +
      `${r.to.padEnd(width("to"))}  ${r.days.padStart(width("days"))}`,
  );
}
console.log("");

for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (warnings.length > 0) {
  console.warn(
    `${warnings.length} event-calendar horizon warning(s) — not failing (--events-warn-only); ` +
      `the scheduled calendar-freshness workflow tracks these strictly.\n`,
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`STALE: ${problem}`);
  console.error(
    `\n${problems.length} problem(s) as of ${today} (threshold: ${minDays} days). ` +
      `Calendars are data, reviewed like data — extend and re-verify them before the horizon lapses.`,
  );
  process.exit(1);
}

const nearest = rows.reduce((a, b) => (a.days <= b.days ? a : b));
console.log(
  `ok: ${rows.length} file(s) fresh as of ${today} — nearest horizon ${nearest.to} ` +
    `(${nearest.file}, ${nearest.days} days remaining, threshold ${minDays})`,
);
