/*
  The shipped macro event calendars are data, and wrong event dates silently
  corrupt every query conditioned on them — so the data files themselves are
  under test: schema-valid, sorted, unique, inside their stated coverage, and
  with per-year counts that match how often the institution actually publishes.
*/
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { eventFileSchema } from "../src/events";
import type { EventFile } from "../src/events";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const eventsDir = join(repoRoot, "data", "events");

const fileNames = readdirSync(eventsDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

const files = new Map<string, EventFile>(
  fileNames.map((name) => [
    name,
    eventFileSchema.parse(JSON.parse(readFileSync(join(eventsDir, name), "utf8"))),
  ]),
);

/** Calendar years [from..to] whose FULL January–December span sits inside coverage. */
function fullyCoveredYears(file: EventFile): number[] {
  const firstYear = Number(file.coverage.from.slice(0, 4));
  const lastYear = Number(file.coverage.to.slice(0, 4));
  const years: number[] = [];
  for (let y = firstYear; y <= lastYear; y++) {
    if (file.coverage.from <= `${y}-01-01` && file.coverage.to >= `${y}-12-31`) years.push(y);
  }
  return years;
}

function countByYear(file: EventFile): Map<number, number> {
  const counts = new Map<number, number>();
  for (const date of file.dates) {
    const year = Number(date.slice(0, 4));
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return counts;
}

describe("shipped event calendars are structurally sound", () => {
  it("ships the four documented calendars", () => {
    expect(fileNames).toEqual(["cpi.json", "fomc.json", "nfp.json", "opex.json"]);
  });

  for (const [name, file] of files) {
    describe(name, () => {
      it("parses against the event file schema with cited sources", () => {
        // eventFileSchema.parse already ran at load; assert the honesty fields too.
        expect(file.sources.length).toBeGreaterThan(0);
        expect(file.version).toMatch(/^\d{4}-\d{2}\.\d+$/);
        expect((file.notes ?? "").length).toBeGreaterThan(0);
      });

      it("lists dates sorted and unique", () => {
        const sorted = [...file.dates].sort();
        expect(file.dates).toEqual(sorted);
        expect(new Set(file.dates).size).toBe(file.dates.length);
      });

      it("keeps every date inside its stated coverage window", () => {
        expect(file.coverage.from <= file.coverage.to).toBe(true);
        for (const date of file.dates) {
          expect(date >= file.coverage.from, `${date} before coverage.from`).toBe(true);
          expect(date <= file.coverage.to, `${date} after coverage.to`).toBe(true);
        }
      });

      it("has at least one date in every covered calendar year (no silent holes)", () => {
        const counts = countByYear(file);
        for (const year of fullyCoveredYears(file)) {
          expect(counts.get(year) ?? 0, `no dates at all in covered year ${year}`).toBeGreaterThan(
            0,
          );
        }
      });
    });
  }
});

describe("FOMC calendar matches how often the Fed actually meets", () => {
  const fomc = files.get("fomc.json") as EventFile;
  const counts = countByYear(fomc);

  it("has at least 6 scheduled statement days in every covered year", () => {
    // The FOMC holds 8 scheduled meetings a year. 2020 legitimately has 7:
    // the scheduled March 17–18, 2020 meeting was superseded by the
    // unscheduled March 15 emergency meeting, and unscheduled meetings are
    // excluded from this file by policy (see fomc.json notes).
    for (const year of fullyCoveredYears(fomc)) {
      const n = counts.get(year) ?? 0;
      expect(n, `FOMC ${year} has ${n} statement days`).toBeGreaterThanOrEqual(6);
      expect(n, `FOMC ${year} has ${n} statement days`).toBeLessThanOrEqual(8);
    }
  });

  it("has exactly 8 statement days in every covered year except 2020", () => {
    for (const year of fullyCoveredYears(fomc)) {
      expect(counts.get(year), `FOMC ${year}`).toBe(year === 2020 ? 7 : 8);
    }
  });
});

for (const name of ["cpi.json", "nfp.json"]) {
  describe(`${name} matches the monthly BLS release cadence`, () => {
    const file = files.get(name) as EventFile;
    const counts = countByYear(file);
    const coverageEndMonth = Number(file.coverage.to.slice(5, 7));
    const lastCoveredYear = Number(file.coverage.to.slice(0, 4));

    it("has 11–13 releases in every fully covered year", () => {
      // These are monthly releases, so a normal year has 12. 2025 legitimately
      // has 11 for both series: the October–November 2025 lapse in federal
      // appropriations meant the October-reference CPI was never published and
      // no Employment Situation was released on the first Fridays of October
      // or November (the September and October+November reports were released
      // late — see each file's notes). 11 is a real count, not a hole, so the
      // 11–13 bound stays honest instead of being loosened.
      for (const year of fullyCoveredYears(file)) {
        const n = counts.get(year) ?? 0;
        expect(n, `${name} ${year} has ${n} releases`).toBeGreaterThanOrEqual(11);
        expect(n, `${name} ${year} has ${n} releases`).toBeLessThanOrEqual(13);
      }
    });

    it("documents the 2025 shutdown gap instead of inventing dates", () => {
      expect(counts.get(2025)).toBe(11);
      expect(file.notes).toMatch(/appropriations/);
    });

    it("covers the final partial year roughly once per covered month", () => {
      // Coverage for these files ends mid-year (the last verifiable scheduled
      // release), so the final year is bounded by its covered months rather
      // than a full year's 11–13.
      const n = counts.get(lastCoveredYear) ?? 0;
      expect(n, `${name} ${lastCoveredYear} has ${n} releases`).toBeGreaterThanOrEqual(
        coverageEndMonth - 2,
      );
      expect(n, `${name} ${lastCoveredYear} has ${n} releases`).toBeLessThanOrEqual(
        coverageEndMonth + 1,
      );
    });
  });
}
