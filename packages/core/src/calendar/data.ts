import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { HolidayCalendar } from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const holidayCalendarSchema = z.object({
  exchange: z.string(),
  version: z.string(),
  sources: z.array(z.string()),
  notes: z.string().optional(),
  coverage: z.object({ from: z.string().regex(ISO_DATE), to: z.string().regex(ISO_DATE) }),
  holidays: z.array(z.object({ date: z.string().regex(ISO_DATE), name: z.string() })),
  halfDays: z.array(
    z.object({
      date: z.string().regex(ISO_DATE),
      name: z.string(),
      close: z.string().regex(HHMM),
    }),
  ),
});

/** Where a store keeps its calendar data (copied in by `edgestats init`). */
export function calendarDir(dataDir: string): string {
  return join(dataDir, "calendar");
}

const cache = new Map<string, HolidayCalendar | null>();

export function loadHolidayCalendar(dataDir: string, exchange: string): HolidayCalendar | null {
  const key = `${dataDir}::${exchange}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const file = join(calendarDir(dataDir), `${exchange.toLowerCase()}.json`);
  if (!existsSync(file)) {
    cache.set(key, null);
    return null;
  }
  const parsed = holidayCalendarSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  cache.set(key, parsed);
  return parsed;
}

export function clearCalendarCache(): void {
  cache.clear();
}

export interface CalendarVersionInfo {
  files: { exchange: string; version: string; coverage: { from: string; to: string } }[];
  hash: string;
}

/** Version fingerprint of the calendar data a store computed its features with. */
export function calendarVersionInfo(dataDir: string): CalendarVersionInfo {
  const dir = calendarDir(dataDir);
  const files: CalendarVersionInfo["files"] = [];
  const hash = createHash("sha256");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const raw = readFileSync(join(dir, name), "utf8");
      hash.update(name).update(raw);
      const parsed = holidayCalendarSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        files.push({
          exchange: parsed.data.exchange,
          version: parsed.data.version,
          coverage: parsed.data.coverage,
        });
      }
    }
  }
  return { files, hash: hash.digest("hex").slice(0, 12) };
}
