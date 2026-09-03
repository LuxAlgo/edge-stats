/*
  Dukascopy historical feed — free FX, index CFD, commodity, and crypto
  minute bars via the public Dukascopy datafeed (the bi5 tick archive),
  fetched and aggregated through the MIT `dukascopy-node` library.

  Keyless. Coverage is deep (major FX pairs back to the 2000s). Two
  honesty notes carried into the docs: volumes are the feed's per-side
  tick volumes, not consolidated market volume, and index/commodity
  symbols are Dukascopy's CFD pricing of those markets, not exchange
  prints. Statistics on session shape are robust to both; say what the
  data is anyway.

  The fetch loop pulls 7-day windows forward from the watermark so memory
  stays bounded on multi-year backfills. Weekend windows legitimately
  return nothing.

  adapterOptions:
    {
      "instrument": "eurusd",  // dukascopy instrument id (default: store symbol lowercased)
      "start": "2010-01-01"    // first-sync lower bound when no watermark exists
    }
*/
import { z } from "zod";
import { getHistoricalRates } from "dukascopy-node";
import type { BarRow } from "../store/store";
import { clampBars, finiteNum, inBatches, normalizeEpochToMs, require1m, sleep } from "./shared";
import type { Adapter, AdapterContext, FetchRequest } from "./types";

const optionsSchema = z.object({
  instrument: z.string().min(1).optional(),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use an ISO date like 2010-01-01")
    .default("2010-01-01"),
});

/** One fetch window; a week of 1m bars is ~7k rows, comfortably bounded. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PACE_MS = 400;

/** Map dukascopy-node JSON rows ({timestamp, open, high, low, close, volume?}) to ascending BarRows. */
export function parseDukascopyRows(rows: unknown, symbol: string, tf: string): BarRow[] {
  if (!Array.isArray(rows)) {
    throw new Error(
      "dukascopy: unexpected rates response (expected an array) — library shape drifted, please open an issue",
    );
  }
  const bars = rows.map((r: unknown) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      throw new Error(
        "dukascopy: rate row is not an object — library shape drifted, please open an issue",
      );
    }
    const row = r as Record<string, unknown>;
    return {
      symbol,
      tf,
      ts: normalizeEpochToMs(finiteNum(row.timestamp, "timestamp", "dukascopy")),
      open: finiteNum(row.open, "open", "dukascopy"),
      high: finiteNum(row.high, "high", "dukascopy"),
      low: finiteNum(row.low, "low", "dukascopy"),
      close: finiteNum(row.close, "close", "dukascopy"),
      volume:
        row.volume === undefined || row.volume === null
          ? 0
          : finiteNum(row.volume, "volume", "dukascopy"),
      contract: null,
    };
  });
  return bars.sort((a, b) => a.ts - b.ts);
}

/** Injectable for tests; production uses dukascopy-node directly. */
export type DukascopyFetcher = (args: {
  instrument: string;
  from: Date;
  to: Date;
}) => Promise<unknown>;

export const defaultDukascopyFetcher: DukascopyFetcher = async ({ instrument, from, to }) =>
  getHistoricalRates({
    // The library validates instrument ids itself and lists them in its docs.
    instrument: instrument as Parameters<typeof getHistoricalRates>[0]["instrument"],
    dates: { from, to },
    timeframe: "m1",
    format: "json",
    volumes: true,
    ignoreFlats: true,
  });

export function makeDukascopyAdapter(fetcher: DukascopyFetcher): Adapter {
  return {
    id: "dukascopy",
    title: "Dukascopy historical feed",
    doc: "Keyless FX, index CFD, commodity, and crypto minute bars from the public Dukascopy tick archive (aggregated via dukascopy-node), pulled in 7-day windows from the watermark forward. Volumes are per-side tick volumes; index symbols are CFD pricing.",
    requiresEnv: [],
    async *fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]> {
      const opts = optionsSchema.parse(ctx.symbol.adapterOptions);
      require1m("dukascopy", ctx.symbol.tf);
      const { symbol, tf } = ctx.symbol;
      const instrument = opts.instrument ?? symbol.toLowerCase();
      const until = req.untilMs;

      let cursor = req.sinceMs ?? Date.parse(`${opts.start}T00:00:00Z`) - 1;
      let pulled = 0;
      while (cursor < until) {
        const windowEnd = Math.min(until, cursor + WINDOW_MS);
        const rows = await fetcher({
          instrument,
          from: new Date(cursor + 1),
          to: new Date(windowEnd),
        });
        const bars = clampBars(parseDukascopyRows(rows, symbol, tf), cursor, until);
        if (bars.length > 0) {
          yield* inBatches(bars);
          pulled += bars.length;
        }
        // Advance past the window even when empty: weekends and market
        // holidays legitimately have no FX ticks.
        cursor = windowEnd;
        if (cursor < until) await sleep(PACE_MS);
      }
      ctx.log(`dukascopy: ${symbol} → ${pulled} bars`);
    },
  };
}

export const dukascopyAdapter: Adapter = makeDukascopyAdapter(defaultDukascopyFetcher);
