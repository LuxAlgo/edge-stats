/*
  Massive flat files — local-first import of the vendor's downloadable
  minute-aggregate CSVs.

  Point adapterOptions.files at one file or a directory; `.csv` and
  `.csv.gz` both work (gzip inflated in memory via fflate). Parsing is
  header-addressed: ts from window_start/timestamp/ts/t, prices from
  open/high/low/close, size from volume/v, and rows for OTHER tickers in a
  whole-market file are skipped via the ticker/symbol column. Timestamp
  units (the vendor's flat files use epoch nanoseconds) are detected by
  magnitude, so seconds/ms/µs/ns all normalize to UTC epoch ms.

  Files are imported in name order — the vendor's date-stamped names
  already sort chronologically; keep custom names sortable the same way,
  because bars must reach the store ascending (same rule as `csv`).

  REST path: TODO — deliberately NOT implemented. The vendor's REST
  surface is still being verified for this adapter, and guessing endpoints
  is worse than saying so. With MASSIVE_API_KEY set and no `files`
  configured, the adapter throws with that guidance instead of inventing a
  URL. Flat files are the supported path today.

  adapterOptions:
    {
      "files": "data/massive/"   // one .csv/.csv.gz, or a directory of them
    }
*/
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { gunzipSync, strFromU8 } from "fflate";
import { z } from "zod";
import type { BarRow } from "../store/store";
import { parseCsvLine } from "./csv";
import { clampBars, epochStrToMs, finiteNum, inBatches, require1m } from "./shared";
import type { Adapter, AdapterContext, FetchRequest } from "./types";

const optionsSchema = z.object({
  files: z.string().optional(),
});

/** Header aliases, first match wins. */
const TS_COLUMNS = ["window_start", "timestamp", "ts", "t"];
const TICKER_COLUMNS = ["ticker", "symbol"];
const VOLUME_COLUMNS = ["volume", "v"];

/** Inflate `.csv.gz` bytes (gzip magic 1f 8b), pass plain CSV through. */
export function inflateMassiveFile(bytes: Uint8Array): string {
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return strFromU8(isGzip ? gunzipSync(bytes) : bytes);
}

/**
 * Parse one flat file. `symbol` filters whole-market files down to the
 * configured ticker; files without a ticker column are taken whole
 * (single-symbol exports).
 */
export function parseMassiveFlatCsv(text: string, symbol: string, tf: string): BarRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) return [];
  const header = parseCsvLine(headerLine, ",").map((h) => h.trim().toLowerCase());
  const find = (names: string[]): number => {
    for (const name of names) {
      const idx = header.indexOf(name);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const iTs = find(TS_COLUMNS);
  const iOpen = header.indexOf("open");
  const iHigh = header.indexOf("high");
  const iLow = header.indexOf("low");
  const iClose = header.indexOf("close");
  const iVolume = find(VOLUME_COLUMNS);
  const iTicker = find(TICKER_COLUMNS);
  if ([iTs, iOpen, iHigh, iLow, iClose].includes(-1)) {
    throw new Error(
      `massive: flat file is missing expected columns (got: ${header.join(", ")}; need ${TS_COLUMNS[0]}/timestamp + open/high/low/close) — file format drifted, please open an issue`,
    );
  }
  const rows: BarRow[] = [];
  for (let li = 1; li < lines.length; li += 1) {
    const line = lines[li];
    if (line === undefined) continue;
    const parts = parseCsvLine(line, ",");
    if (iTicker >= 0 && parts[iTicker] !== symbol) continue;
    const tsRaw = parts[iTs];
    if (tsRaw === undefined || tsRaw === "") continue;
    rows.push({
      symbol,
      tf,
      ts: epochStrToMs(tsRaw),
      open: finiteNum(parts[iOpen], "open", "massive"),
      high: finiteNum(parts[iHigh], "high", "massive"),
      low: finiteNum(parts[iLow], "low", "massive"),
      close: finiteNum(parts[iClose], "close", "massive"),
      volume: iVolume >= 0 ? finiteNum(parts[iVolume], "volume", "massive") : 0,
      contract: null,
    });
  }
  return rows;
}

function isFlatFile(name: string): boolean {
  return name.endsWith(".csv") || name.endsWith(".csv.gz");
}

function* flatFiles(base: string): Generator<string> {
  let st;
  try {
    st = statSync(base);
  } catch {
    throw new Error(
      `massive: no such file or directory '${base}' — point adapterOptions.files at your downloaded flat files`,
    );
  }
  if (st.isFile()) {
    yield base;
    return;
  }
  for (const name of readdirSync(base).sort()) {
    if (isFlatFile(name)) yield join(base, name);
  }
}

export const massiveAdapter: Adapter = {
  id: "massive",
  title: "Massive flat files",
  doc: "Imports Massive minute-aggregate flat files (.csv/.csv.gz) from disk — download them from your Massive account, point `files` at the folder. REST pull is a documented TODO.",
  requiresEnv: [],
  async *fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]> {
    const opts = optionsSchema.parse(ctx.symbol.adapterOptions);
    require1m("massive", ctx.symbol.tf);
    const { symbol, tf } = ctx.symbol;

    if (opts.files === undefined) {
      // TODO(massive-rest): connect the REST pull once the vendor's
      // endpoint shape is verified against their current docs. Guessed
      // URLs would fail confusingly at best — refuse loudly instead.
      if (ctx.env.MASSIVE_API_KEY !== undefined) {
        throw new Error(
          "massive: the REST pull is not implemented yet — MASSIVE_API_KEY was detected but is not used. " +
            "Download flat files from your Massive account and set adapterOptions.files to the folder; " +
            "track the TODO in packages/core/src/adapters/massive.ts",
        );
      }
      throw new Error(
        "massive: nothing to import — set adapterOptions.files to a flat file or directory " +
          "(the REST pull is a documented TODO and additionally needs MASSIVE_API_KEY)",
      );
    }

    const base = isAbsolute(opts.files) ? opts.files : resolve(ctx.dataDir, "..", opts.files);
    let cursor = req.sinceMs;
    let imported = 0;
    for (const file of flatFiles(base)) {
      const text = inflateMassiveFile(new Uint8Array(readFileSync(file)));
      const bars = clampBars(parseMassiveFlatCsv(text, symbol, tf), cursor, req.untilMs);
      if (bars.length > 0) {
        yield* inBatches(bars);
        cursor = bars[bars.length - 1]?.ts ?? cursor;
        imported += bars.length;
      }
      ctx.log(`massive: imported ${file} → ${bars.length} bars`);
    }
    ctx.log(`massive: ${symbol} → ${imported} bars from flat files`);
  },
};
