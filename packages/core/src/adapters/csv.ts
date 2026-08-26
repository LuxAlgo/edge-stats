/*
  Generic CSV importer: any bars from anywhere — vendor files, TradingView
  exports, your own recordings — mapped by config. Timestamps can be epoch
  seconds/millis or ISO datetimes (with an optional fixed zone offset
  handled by the ISO string itself).

  adapterOptions:
    {
      "path": "bars/",                 // file or directory of *.csv
      "delimiter": ",",
      "mapping": {
        "ts": "timestamp",             // epoch or ISO column…
        "open": "open", "high": "high", "low": "low", "close": "close",
        "volume": "volume",            // optional (default 0)
        "contract": "contract"         // optional (futures roll detection)
      },
      "tsUnit": "ms" | "s" | "iso"
    }
*/
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { BarRow } from "../store/store";
import type { Adapter, AdapterContext, FetchRequest } from "./types";

const optionsSchema = z.object({
  path: z.string(),
  delimiter: z.string().default(","),
  tsUnit: z.enum(["ms", "s", "iso"]).default("ms"),
  mapping: z.object({
    ts: z.string(),
    open: z.string(),
    high: z.string(),
    low: z.string(),
    close: z.string(),
    volume: z.string().optional(),
    contract: z.string().optional(),
  }),
});

/** Minimal RFC-4180-ish parser: quoted fields, doubled-quote escapes. */
export function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

function parseTs(raw: string, unit: "ms" | "s" | "iso"): number {
  if (unit === "iso") {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) throw new Error(`unparseable ISO timestamp: '${raw}'`);
    return ms;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`unparseable timestamp: '${raw}'`);
  return unit === "s" ? n * 1000 : n;
}

function* csvFiles(base: string): Generator<string> {
  const st = statSync(base);
  if (st.isFile()) {
    yield base;
    return;
  }
  for (const name of readdirSync(base).sort()) {
    if (name.endsWith(".csv")) yield join(base, name);
  }
}

export const csvAdapter: Adapter = {
  id: "csv",
  title: "CSV / flat-file importer",
  doc: "Imports bars from local CSV files with a column mapping. The universal escape hatch: if your data source can export a file, Edge Stats can compute on it.",
  requiresEnv: [],
  async *fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]> {
    const opts = optionsSchema.parse(ctx.symbol.adapterOptions);
    const base = isAbsolute(opts.path) ? opts.path : resolve(ctx.dataDir, "..", opts.path);
    for (const file of csvFiles(base)) {
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
      if (lines.length < 2) continue;
      const headerLine = lines[0];
      if (!headerLine) continue;
      const header = parseCsvLine(headerLine, opts.delimiter).map((h) => h.trim());
      const col = (name: string): number => {
        const idx = header.indexOf(name);
        if (idx === -1) {
          throw new Error(`${file}: no column '${name}' (columns: ${header.join(", ")})`);
        }
        return idx;
      };
      const m = opts.mapping;
      const iTs = col(m.ts);
      const iOpen = col(m.open);
      const iHigh = col(m.high);
      const iLow = col(m.low);
      const iClose = col(m.close);
      const iVolume = m.volume ? col(m.volume) : -1;
      const iContract = m.contract ? col(m.contract) : -1;

      const batch: BarRow[] = [];
      for (let li = 1; li < lines.length; li += 1) {
        const line = lines[li];
        if (!line) continue;
        const parts = parseCsvLine(line, opts.delimiter);
        const tsRaw = parts[iTs];
        if (tsRaw === undefined || tsRaw === "") continue;
        const ts = parseTs(tsRaw, opts.tsUnit);
        if (req.sinceMs !== null && ts <= req.sinceMs) continue;
        if (ts > req.untilMs) continue;
        batch.push({
          symbol: ctx.symbol.symbol,
          tf: ctx.symbol.tf,
          ts,
          open: Number(parts[iOpen]),
          high: Number(parts[iHigh]),
          low: Number(parts[iLow]),
          close: Number(parts[iClose]),
          volume: iVolume >= 0 ? Number(parts[iVolume]) : 0,
          contract: iContract >= 0 && parts[iContract] !== "" ? (parts[iContract] ?? null) : null,
        });
        if (batch.length >= 50_000) {
          yield batch.splice(0, batch.length);
        }
      }
      if (batch.length > 0) yield batch;
      ctx.log(`csv: imported ${file}`);
    }
  },
};
