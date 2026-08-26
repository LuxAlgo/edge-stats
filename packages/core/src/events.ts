/*
  Macro event calendars (FOMC, CPI, NFP, OPEX, …) ship as versioned data
  files with cited sources and coverage horizons — the freshness check reds
  when a horizon nears. `eventDay('FOMC')` is a first-class predicate.
*/
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "./store/store";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const eventFileSchema = z.object({
  event: z.string().min(1),
  version: z.string(),
  sources: z.array(z.string()),
  notes: z.string().optional(),
  coverage: z.object({ from: z.string().regex(ISO_DATE), to: z.string().regex(ISO_DATE) }),
  dates: z.array(z.string().regex(ISO_DATE)),
});
export type EventFile = z.infer<typeof eventFileSchema>;

export function eventsDir(dataDir: string): string {
  return join(dataDir, "events");
}

export function loadEventFiles(dataDir: string): EventFile[] {
  const dir = eventsDir(dataDir);
  if (!existsSync(dir)) return [];
  const files: EventFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    files.push(eventFileSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
  }
  return files;
}

export async function syncEventsIntoStore(store: Store): Promise<number> {
  const files = loadEventFiles(store.dataDir);
  const entries = files.flatMap((f) => f.dates.map((date) => ({ date, event: f.event })));
  await store.replaceEvents(entries);
  return entries.length;
}
