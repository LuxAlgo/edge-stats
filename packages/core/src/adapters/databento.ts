/*
  Databento historical — CME futures minute bars (GLBX.MDP3), pay-as-you-go.

  Continuous contracts by volume rank: config symbol "ES" is requested as
  "ES.v.0" with stype_in=continuous, and map_symbols=true adds the raw
  contract (ESH4, …) to every row — that lands in BarRow.contract, which
  is what the engine's roll detection reads. A gap across a roll is a
  roll, not a gap.

  COST PREFLIGHT IS MANDATORY. Databento meters by data pulled; before
  fetching anything this adapter calls metadata.get_cost for the exact
  same range and REFUSES to pull when the estimate exceeds
  adapterOptions.maxCostUsd (default $5). Raise the cap only when you mean
  to spend it. Pricing is the vendor's — the preflight asks their
  metering; nothing here hardcodes a price.

  Env (BYO key — read from the environment, never logged, never stored):
    DATABENTO_API_KEY   (sent as the HTTP Basic username)

  adapterOptions:
    {
      "maxCostUsd": 5,          // hard spend cap per sync pull
      "dataset": "GLBX.MDP3",
      "start": "2010-06-06"     // first-sync lower bound when no watermark exists
    }
*/
import { Buffer } from "node:buffer";
import { z } from "zod";
import type { BarRow } from "../store/store";
import { parseCsvLine } from "./csv";
import { clampBars, epochStrToMs, fetchWithRetry, finiteNum, inBatches, require1m } from "./shared";
import type { Adapter, AdapterContext, FetchRequest } from "./types";

const optionsSchema = z.object({
  maxCostUsd: z.number().positive().default(5),
  dataset: z.string().default("GLBX.MDP3"),
  // VERIFY-LIVE: GLBX.MDP3 coverage is documented as starting 2010-06-06;
  // adjust if the vendor's dataset page says otherwise.
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use an ISO date like 2018-01-01")
    .default("2010-06-06"),
});

const HIST_BASE = "https://hist.databento.com/v0";

export interface DatabentoRange {
  dataset: string;
  /** Futures root, e.g. "ES" — requested as the volume-ranked continuous "<root>.v.0". */
  symbolRoot: string;
  /** Inclusive start, ISO 8601 UTC. */
  startIso: string;
  /** Exclusive end, ISO 8601 UTC. */
  endIso: string;
}

/**
 * The query params shared by metadata.get_cost and timeseries.get_range —
 * ONE place to pin in tests and to fix on vendor drift. The cost estimate
 * is only honest when both endpoints see the identical range.
 */
export function databentoParams(range: DatabentoRange): Record<string, string> {
  return {
    dataset: range.dataset,
    symbols: `${range.symbolRoot}.v.0`,
    stype_in: "continuous",
    schema: "ohlcv-1m",
    start: range.startIso,
    end: range.endIso,
  };
}

export function databentoCostUrl(range: DatabentoRange): string {
  const p = new URLSearchParams(databentoParams(range));
  return `${HIST_BASE}/metadata.get_cost?${p.toString()}`;
}

export function databentoRangeUrl(range: DatabentoRange): string {
  const p = new URLSearchParams({
    ...databentoParams(range),
    encoding: "csv",
    // VERIFY-LIVE: pretty_px=true → decimal price strings; pretty_ts=false
    // keeps ts_event as raw nanoseconds; map_symbols=true appends the raw
    // contract per row in a 'symbol' column. Param names per the v0
    // historical API — the daily canary fails loudly if these drift.
    pretty_px: "true",
    pretty_ts: "false",
    map_symbols: "true",
  });
  return `${HIST_BASE}/timeseries.get_range?${p.toString()}`;
}

/** HTTP Basic with the API key as username and a blank password. */
export function databentoAuthHeader(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const key = env.DATABENTO_API_KEY;
  if (key === undefined) {
    throw new Error(
      "databento: missing env DATABENTO_API_KEY — export it in your shell; keys stay on your box",
    );
  }
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` };
}

/**
 * metadata.get_cost answers in US dollars — historically a bare JSON
 * number; an object wrapper with a cost field is tolerated too.
 * VERIFY-LIVE: field names, should the vendor wrap the response.
 */
export function parseDatabentoCost(body: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    parsed = undefined;
  }
  if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    for (const field of ["cost", "total_cost", "usd"]) {
      const v = (parsed as Record<string, unknown>)[field];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  throw new Error(
    "databento: could not read a number from metadata.get_cost — API shape drifted; refusing to pull data without a working cost preflight",
  );
}

/** The guard between an estimate and your card. Throws above the cap. */
export function assertCostWithinCap(
  estimatedUsd: number,
  maxCostUsd: number,
  rangeLabel: string,
): void {
  if (estimatedUsd > maxCostUsd) {
    throw new Error(
      `databento: estimated cost $${estimatedUsd.toFixed(2)} for ${rangeLabel} exceeds your $${maxCostUsd.toFixed(2)} cap — ` +
        `sync a narrower range (or more often), or raise "maxCostUsd" in adapterOptions if you mean to spend this`,
    );
  }
}

/**
 * Parse the ohlcv-1m CSV (header-addressed, so column order/extras can
 * drift without breaking): ts_event in nanoseconds → ms via BigInt; the
 * mapped 'symbol' column (raw contract) → BarRow.contract.
 */
export function parseDatabentoOhlcvCsv(text: string, symbol: string, tf: string): BarRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) return [];
  const header = parseCsvLine(headerLine, ",").map((h) => h.trim());
  const col = (name: string): number => header.indexOf(name);
  const iTs = col("ts_event");
  const iOpen = col("open");
  const iHigh = col("high");
  const iLow = col("low");
  const iClose = col("close");
  const iVolume = col("volume");
  const iContract = col("symbol");
  if ([iTs, iOpen, iHigh, iLow, iClose, iVolume].includes(-1)) {
    throw new Error(
      `databento: ohlcv-1m CSV is missing expected columns (got: ${header.join(", ")}) — API shape drifted, please open an issue`,
    );
  }
  const rows: BarRow[] = [];
  for (let li = 1; li < lines.length; li += 1) {
    const line = lines[li];
    if (line === undefined) continue;
    const parts = parseCsvLine(line, ",");
    const tsRaw = parts[iTs];
    if (tsRaw === undefined || tsRaw === "") continue;
    const contract = iContract >= 0 ? (parts[iContract] ?? "") : "";
    rows.push({
      symbol,
      tf,
      ts: epochStrToMs(tsRaw),
      open: finiteNum(parts[iOpen], "open", "databento"),
      high: finiteNum(parts[iHigh], "high", "databento"),
      low: finiteNum(parts[iLow], "low", "databento"),
      close: finiteNum(parts[iClose], "close", "databento"),
      volume: finiteNum(parts[iVolume], "volume", "databento"),
      contract: contract === "" ? null : contract,
    });
  }
  return rows;
}

export const databentoAdapter: Adapter = {
  id: "databento",
  title: "Databento CME futures",
  doc: "CME Globex minute bars (continuous front contract by volume) from Databento historical. Pay-as-you-go: every pull runs a mandatory cost preflight against adapterOptions.maxCostUsd.",
  requiresEnv: ["DATABENTO_API_KEY"],
  async *fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]> {
    const opts = optionsSchema.parse(ctx.symbol.adapterOptions);
    require1m("databento", ctx.symbol.tf);
    const { symbol, tf } = ctx.symbol;
    const headers = databentoAuthHeader(ctx.env);
    const authHint = "check DATABENTO_API_KEY";

    const cursor = req.sinceMs ?? Date.parse(`${opts.start}T00:00:00Z`) - 1;
    if (cursor >= req.untilMs) return;
    const range: DatabentoRange = {
      dataset: opts.dataset,
      symbolRoot: symbol,
      startIso: new Date(cursor + 1).toISOString(),
      endIso: new Date(req.untilMs + 1).toISOString(), // databento's end is exclusive
    };
    const rangeLabel = `${symbol}.v.0 ${range.startIso} → ${range.endIso}`;

    // 1) Mandatory cost preflight — same params, vendor's own metering.
    const costRes = await fetchWithRetry(databentoCostUrl(range), {
      what: "databento cost preflight",
      init: { headers },
      authHint,
    });
    const estimatedUsd = parseDatabentoCost(await costRes.text());
    ctx.log(`databento: estimated cost $${estimatedUsd.toFixed(4)} for ${rangeLabel}`);
    assertCostWithinCap(estimatedUsd, opts.maxCostUsd, rangeLabel);

    // 2) The pull. One ranged request; the cost cap doubles as a size cap,
    //    and the batcher keeps yields within the sync loop's limits.
    const res = await fetchWithRetry(databentoRangeUrl(range), {
      what: "databento get_range",
      init: { headers },
      authHint,
    });
    const bars = clampBars(
      parseDatabentoOhlcvCsv(await res.text(), symbol, tf),
      cursor,
      req.untilMs,
    );
    if (bars.length > 0) yield* inBatches(bars);
    ctx.log(`databento: ${symbol} → ${bars.length} bars`);
  },
};
