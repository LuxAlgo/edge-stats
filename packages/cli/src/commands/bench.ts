/*
  `edgestats bench`: the performance gate. Times a battery of
  representative queries against the current store; CI runs it against the
  demo store and fails on regression. Interactivity is a feature: a preset
  over years of 1-minute bars answers in milliseconds or it's a bug.
*/
import { performance } from "node:perf_hooks";
import { runQuery } from "@luxalgo/edge-stats";
import pc from "picocolors";
import type { CliContext } from "../context";

const BATTERY: { name: string; dsl: string; groupBy?: string }[] = [
  { name: "gap-fill", dsl: "gapFill" },
  {
    name: "gap-fill-conditioned",
    dsl: "gapFill WHERE gapPct BETWEEN 0.1% AND 0.8% AND dayOfWeek = Tue",
  },
  { name: "gap-fill-by-weekday", dsl: "gapFill", groupBy: "dayOfWeek" },
  { name: "orb-15m", dsl: "orbBreak(15m, up)" },
  { name: "orb-target-ladder", dsl: "orbTargetHit(15m, 1)" },
  { name: "ib-extension", dsl: "ibExtension(0.5)" },
  { name: "prev-high-touch", dsl: "touchPrevHigh WHERE openPosInPrevRange >= 0.5" },
  { name: "streak-reversion", dsl: "closeGreen WHERE streak(red, 2)" },
  { name: "event-day", dsl: "closeGreen WHERE eventDay('OPEX')" },
  { name: "time-of-high", dsl: "timeOfHighBefore(60m)" },
];

export interface BenchResult {
  name: string;
  ms: number;
  n: number;
}

export async function runBench(ctx: CliContext, maxMs: number, json: boolean): Promise<void> {
  const symbol = ctx.config.symbols[0];
  if (!symbol) throw new Error("no symbols configured: run `edgestats init --demo` first");

  // Warm the store (first query pays DuckDB catalog + IO warmup).
  await runQuery(ctx.store, ctx.config, {
    dsl: "closeGreen",
    symbol: symbol.symbol,
    sessionsLimit: 0,
  });

  const results: BenchResult[] = [];
  for (const item of BATTERY) {
    const start = performance.now();
    const res = await runQuery(ctx.store, ctx.config, {
      dsl: item.dsl,
      symbol: symbol.symbol,
      groupBy: item.groupBy,
      sessionsLimit: 25,
    });
    const ms = performance.now() - start;
    results.push({ name: item.name, ms: Math.round(ms * 10) / 10, n: res.n });
  }
  const worst = results.reduce((a, b) => (b.ms > a.ms ? b : a));
  if (json) {
    console.log(
      JSON.stringify(
        { symbol: symbol.symbol, results, worstMs: worst.ms, budgetMs: maxMs },
        null,
        2,
      ),
    );
  } else {
    console.log(pc.bold(`bench · ${symbol.symbol} · budget ${maxMs}ms per query`));
    for (const r of results) {
      const flag = r.ms > maxMs ? pc.red(" OVER BUDGET") : "";
      console.log(`  ${r.name.padEnd(24)} ${String(r.ms).padStart(8)}ms   N=${r.n}${flag}`);
    }
    console.log(pc.dim(`  worst: ${worst.name} at ${worst.ms}ms`));
  }
  if (worst.ms > maxMs) {
    console.error(pc.red(`bench failed: ${worst.name} took ${worst.ms}ms (> ${maxMs}ms)`));
    process.exit(1);
  }
}
