/*
  Synthetic bars: the zero-key, zero-cost demo path. Deterministic (seeded)
  so docs, goldens, and benchmarks reproduce bit-for-bit on any machine.
  Two profiles:

    equity — NYSE RTH sessions, 1-minute bars, cash-index-like levels
    future — CME Globex sessions with quarterly contracts and volume-style
             rolls (8 days before the 3rd Friday), including the small
             basis jump at each roll that the engine must NOT count as a gap

  The generator is calibrated to look plausible (U-shaped intraday vol,
  gap mixtures, trend/range day types), not to encode any real market's
  statistics. It exists so `edgestats init --demo` works on a clean machine
  with no accounts anywhere.
*/
import { DateTime } from "luxon";
import { z } from "zod";
import type { BarRow } from "../store/store";
import { gaussian, mulberry32 } from "../util/rng";
import type { Adapter, AdapterContext, FetchRequest } from "./types";

const optionsSchema = z.object({
  profile: z.enum(["equity", "future"]).default("equity"),
  seed: z.number().int().default(42),
  from: z.string().default("2023-01-02"),
  to: z.string().default("2024-12-30"),
  startPrice: z.number().positive().optional(),
});

function thirdFriday(year: number, month: number): DateTime {
  let d = DateTime.utc(year, month, 1);
  while (d.weekday !== 5) d = d.plus({ days: 1 });
  return d.plus({ days: 14 });
}

/** Contract label + roll schedule for a quarterly future (H/M/U/Z). */
function contractFor(dateIso: string, root: string): string {
  const d = DateTime.fromISO(dateIso, { zone: "utc" });
  const quarters = [3, 6, 9, 12];
  const letters: Record<number, string> = { 3: "H", 6: "M", 9: "U", 12: "Z" };
  for (const q of quarters) {
    const roll = thirdFriday(d.year, q).minus({ days: 8 });
    if (d < roll) {
      return `${root}${letters[q]}${String(d.year % 100).padStart(2, "0")}`;
    }
  }
  return `${root}H${String((d.year + 1) % 100).padStart(2, "0")}`;
}

function roundTick(price: number, tick: number): number {
  return Math.round(price / tick) * tick;
}

export const syntheticAdapter: Adapter = {
  id: "synthetic",
  title: "Synthetic demo bars",
  doc: "Deterministic, seeded synthetic bars for the zero-key demo. Not real market data; calibrated for plausibility, not for any real statistic.",
  requiresEnv: [],
  async *fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]> {
    const opts = optionsSchema.parse(ctx.symbol.adapterOptions);
    const isFuture = opts.profile === "future";
    const sessionKey = isFuture ? "globex" : "rth";
    const tick = isFuture ? 0.25 : 0.01;
    const startPrice = opts.startPrice ?? (isFuture ? 5000 : 450);
    const sessions = ctx.resolveSessions(sessionKey, opts.from, opts.to);
    const rng = mulberry32(opts.seed);

    let lastClose = startPrice;
    let lastContract: string | null = null;
    let batch: BarRow[] = [];

    for (const session of sessions) {
      const minutes = Math.floor((session.endMs - session.startMs) / 60_000);
      if (minutes <= 0) continue;

      const contract = isFuture ? contractFor(session.tradeDate, ctx.symbol.symbol) : null;
      if (isFuture && lastContract !== null && contract !== lastContract) {
        // Roll: the new front month trades at a small basis to the old one.
        const basisPct = 0.1 + 0.3 * rng();
        lastClose *= 1 + (rng() < 0.5 ? -1 : 1) * (basisPct / 100);
      }
      lastContract = contract;

      // Opening gap: mixture of mostly-small dislocations.
      const u = rng();
      const mag = u < 0.6 ? 0.12 * rng() : u < 0.9 ? 0.15 + 0.35 * rng() : 0.5 + 1.0 * rng();
      const gapSign = rng() < 0.52 ? 1 : -1;
      const open = roundTick(lastClose * (1 + (gapSign * mag) / 100), tick);

      // Day type: trend days drift, range days mean-revert around the open.
      const dayRoll = rng();
      const drift = dayRoll < 0.22 ? 0.0009 / 60 : dayRoll < 0.44 ? -0.0009 / 60 : 0;

      const baseSigma = isFuture ? 0.00035 : 0.00045;
      const activeStart = isFuture ? 930 : 0; // Globex minutes before the 09:30 ET cash open
      const activeEnd = activeStart + 390;

      let close = open;
      const sessionBars: BarRow[] = [];
      for (let t = 0; t < minutes; t += 1) {
        const inActive = t >= activeStart && t < activeEnd;
        const edge =
          1 +
          1.2 * Math.exp(-Math.max(0, t - activeStart) / 30) +
          0.8 * Math.exp(-Math.max(0, activeEnd - t) / 45);
        const regime = isFuture ? (inActive ? 1 : 0.3) : 1;
        const sigma = baseSigma * regime * (inActive ? edge : 1);

        const z = gaussian(rng);
        const prev = close;
        close = prev * (1 + drift + sigma * z);
        const wick = Math.abs(gaussian(rng)) * sigma * 0.6 * prev;
        const o = roundTick(prev, tick);
        const c = roundTick(close, tick);
        const high = roundTick(Math.max(o, c) + wick, tick);
        const low = roundTick(Math.max(tick, Math.min(o, c) - wick), tick);
        const volume = Math.max(
          1,
          Math.round((isFuture ? (inActive ? 900 : 120) : 1200) * edge * (0.5 + rng())),
        );
        sessionBars.push({
          symbol: ctx.symbol.symbol,
          tf: ctx.symbol.tf,
          ts: session.startMs + t * 60_000,
          open: o,
          high,
          low,
          close: c,
          volume,
          contract,
        });
      }
      const lastBar = sessionBars[sessionBars.length - 1];
      if (lastBar) lastClose = lastBar.close;

      for (const bar of sessionBars) {
        if (req.sinceMs !== null && bar.ts <= req.sinceMs) continue;
        if (bar.ts > req.untilMs) continue;
        batch.push(bar);
      }
      if (batch.length >= 50_000) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
    ctx.log(
      `synthetic: generated ${opts.profile} bars ${opts.from} → ${opts.to} (seed ${opts.seed})`,
    );
  },
};
