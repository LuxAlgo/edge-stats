#!/usr/bin/env node
/*
  edgestats — every trading-stats report is one query: P(outcome | conditions).
  Local store, honest statistics, your data. MIT, no telemetry.
*/
import { Command } from "commander";
import pc from "picocolors";
import {
  DslSyntaxError,
  QueryError,
  describeRegistry,
  exportQuery,
  exportTable,
  freshness,
  groupableFields,
  listAdapters,
  makeSessionResolver,
  renderDslError,
  runPreset,
  runQuery,
  syncSymbols,
  findSymbol,
  type ExportFormat,
} from "@luxalgo/edge-stats";
import { openContext } from "./context";
import { runInit } from "./commands/init";
import { runBench } from "./commands/bench";
import { runTradesImport, runTradesStatus } from "./commands/trades";
import { runLiveAlerts, runLiveOnce, runLiveReplay, runLiveWatch } from "./commands/live";
import { startServer } from "./commands/serve";
import { fail, pct, renderResult } from "./render";

const program = new Command();

program
  .name("edgestats")
  .description(
    "Open-source trading-statistics engine: composable conditional-probability queries over your own bars, with N and confidence intervals on every result.",
  )
  .option("--dir <dir>", "directory containing edge-stats.config.json (default: cwd)");

function dirOpt(): string | undefined {
  return program.opts<{ dir?: string }>().dir;
}

function parseParams(pairs: string[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx === -1) fail(`--param wants key=value, got '${pair}'`);
    const key = pair.slice(0, idx);
    const raw = pair.slice(idx + 1);
    const num = Number(raw);
    out[key] = Number.isFinite(num) && raw.trim() !== "" ? num : raw;
  }
  return out;
}

function collectPairs(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function splitPair(pair: string): [string, string] {
  const idx = pair.indexOf("=");
  if (idx === -1) fail(`expected KEY=VALUE, got '${pair}'`);
  return [pair.slice(0, idx), pair.slice(idx + 1)];
}

function handleError(err: unknown, dsl?: string): never {
  if (err instanceof DslSyntaxError && dsl !== undefined) {
    fail(renderDslError(dsl, err));
  }
  if (err instanceof QueryError) {
    fail(`${err.message}${err.hint ? `\nhint: ${err.hint}` : ""}`);
  }
  fail(err instanceof Error ? err.message : String(err));
}

program
  .command("init")
  .description("create edge-stats.config.json and the local data directory")
  .option("--demo", "add deterministic synthetic demo symbols and sync them", false)
  .option("--force", "overwrite an existing config", false)
  .option("--quiet", "minimal output", false)
  .action(async (opts: { demo: boolean; force: boolean; quiet: boolean }) => {
    try {
      await runInit({ dir: dirOpt() ?? process.cwd(), ...opts });
    } catch (err) {
      handleError(err);
    }
  });

program
  .command("sync")
  .description("pull bars from adapters to the watermark and derive session features")
  .option("--symbol <symbols...>", "only these symbols")
  .option("--full", "re-pull from scratch (drops and re-ingests the symbol bars)", false)
  .action(async (opts: { symbol?: string[]; full: boolean }) => {
    const ctx = await openContext(dirOpt());
    try {
      const summary = await syncSymbols(ctx.store, ctx.config, {
        symbols: opts.symbol,
        full: opts.full,
        log: (msg) => console.log(pc.dim(msg)),
      });
      for (const s of summary.symbols) {
        console.log(`${s.symbol}: +${s.barsInserted} bars (adapter ${s.adapter})`);
      }
      console.log(
        pc.dim(
          `events: ${summary.events} dates · derived: ${summary.derived
            .map((d) => `${d.symbol}/${d.sessionKey}=${d.sessions}`)
            .join(", ")}`,
        ),
      );
    } catch (err) {
      handleError(err);
    } finally {
      await ctx.store.close();
    }
  });

program
  .command("query")
  .description("run a DSL query: P(outcome | conditions) with N, CI, and stability")
  .argument("<dsl>", 'e.g. "gapFill WHERE dayOfWeek = Tue AND gapPct BETWEEN 0.2% AND 0.6%"')
  .requiredOption("--symbol <symbol>", "symbol to query")
  .option("--session <key>", "session window (default: the symbol default)")
  .option("--since <date>", "ISO date lower bound")
  .option("--until <date>", "ISO date upper bound")
  .option(
    "--group <field>",
    `group results by a field (${groupableFields().slice(0, 4).join(", ")}, …)`,
  )
  .option("--sessions <n>", "matching sessions to list", "25")
  .option("--force", "show estimates even below the refuse floor", false)
  .option("--json", "emit the full result envelope as JSON", false)
  .action(async (dsl: string, opts: Record<string, string | boolean>) => {
    const ctx = await openContext(dirOpt());
    try {
      const result = await runQuery(ctx.store, ctx.config, {
        dsl,
        symbol: String(opts.symbol),
        sessionKey: opts.session ? String(opts.session) : undefined,
        since: opts.since ? String(opts.since) : undefined,
        until: opts.until ? String(opts.until) : undefined,
        groupBy: opts.group ? String(opts.group) : undefined,
        sessionsLimit: Number(opts.sessions),
        force: opts.force === true,
      });
      console.log(opts.json === true ? JSON.stringify(result, null, 2) : renderResult(result));
    } catch (err) {
      handleError(err, dsl);
    } finally {
      await ctx.store.close();
    }
  });

program
  .command("report")
  .description("run a preset from the catalog")
  .argument("<preset>", "preset id (list them with `edgestats presets`)")
  .requiredOption("--symbol <symbol>", "symbol to query")
  .option("--param <key=value...>", "preset parameters", [])
  .option("--session <key>", "session window")
  .option("--since <date>", "ISO date lower bound")
  .option("--until <date>", "ISO date upper bound")
  .option("--group <field>", "group results by a field")
  .option("--json", "emit the full result envelope as JSON", false)
  .action(async (presetId: string, opts: Record<string, unknown>) => {
    const ctx = await openContext(dirOpt());
    try {
      const result = await runPreset(ctx.store, ctx.config, ctx.presets, {
        presetId,
        symbol: String(opts.symbol),
        params: parseParams((opts.param as string[]) ?? []),
        sessionKey: opts.session ? String(opts.session) : undefined,
        since: opts.since ? String(opts.since) : undefined,
        until: opts.until ? String(opts.until) : undefined,
        groupBy: opts.group ? String(opts.group) : undefined,
      });
      console.log(opts.json === true ? JSON.stringify(result, null, 2) : renderResult(result));
    } catch (err) {
      handleError(err);
    } finally {
      await ctx.store.close();
    }
  });

program
  .command("presets")
  .description("list the preset catalog")
  .option("--category <category>", "filter by category")
  .option("--json", "emit JSON", false)
  .action(async (opts: { category?: string; json: boolean }) => {
    const ctx = await openContext(dirOpt());
    try {
      const presets = ctx.presets.filter((p) => !opts.category || p.category === opts.category);
      if (opts.json) {
        console.log(JSON.stringify(presets, null, 2));
        return;
      }
      for (const p of presets) {
        console.log(`${pc.bold(p.id.padEnd(22))} ${p.title} ${pc.dim(`[${p.category}]`)}`);
        console.log(pc.dim(`  ${p.summary.split("\n")[0]}`));
        if (p.params.length > 0) {
          console.log(pc.dim(`  params: ${p.params.map((x) => x.name).join(", ")}`));
        }
      }
      console.log(pc.dim(`\n${presets.length} presets: each is one query file in presets/`));
    } finally {
      await ctx.store.close();
    }
  });

program
  .command("fields")
  .description("the registry: every field, predicate, and outcome, with definitions")
  .option("--kind <kind>", "field | predicate | outcome")
  .option("--json", "emit JSON", false)
  .action(async (opts: { kind?: "field" | "predicate" | "outcome"; json: boolean }) => {
    const entries = describeRegistry(opts.kind);
    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    for (const kind of ["outcome", "predicate", "field"] as const) {
      const group = entries.filter((e) => e.kind === kind);
      if (group.length === 0) continue;
      console.log(pc.bold(`\n${kind.toUpperCase()}S (${group.length})`));
      for (const e of group) {
        const args = e.args?.length ? `(${e.args.map((a) => a.name).join(", ")})` : "";
        const type = e.valueType ? pc.dim(` : ${e.valueType}${e.unit ? ` ${e.unit}` : ""}`) : "";
        console.log(`  ${pc.cyan(e.name)}${args}${type}: ${e.doc.split("\n")[0]}`);
      }
    }
  });

program
  .command("adapters")
  .description("list data adapters and the env keys they need")
  .action(() => {
    for (const a of listAdapters()) {
      console.log(`${pc.bold(a.id.padEnd(12))} ${a.title}`);
      console.log(pc.dim(`  ${a.doc.split("\n")[0]}`));
      if (a.requiresEnv.length > 0) console.log(pc.dim(`  env: ${a.requiresEnv.join(", ")}`));
    }
  });

const trades = program
  .command("trades")
  .description("tag sessions with your own imported trades (TRADED, TRADED_WIN, TRADED_LOSS)");

trades
  .command("import")
  .description("import fills from a broker (read-only, env credentials) or a statement CSV")
  .option("--broker <id>", "broker id from @luxalgo/broker-sdk (see `edgestats trades`)")
  .option("--csv <path>", "broker statement CSV with symbol/side/quantity/price columns")
  .option(
    "--map <FROM=TO...>",
    "map broker symbols to store symbols (e.g. ESU6=ES)",
    collectPairs,
    [],
  )
  .option(
    "--mult <SYM=N...>",
    "contract multiplier per store symbol (e.g. ES=50)",
    collectPairs,
    [],
  )
  .action(async (opts: { broker?: string; csv?: string; map: string[]; mult: string[] }) => {
    const ctx = await openContext(dirOpt());
    try {
      const map: Record<string, string> = {};
      for (const [k, v] of opts.map.map(splitPair)) map[k] = v;
      const multipliers: Record<string, number> = {};
      for (const [k, v] of opts.mult.map(splitPair)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0)
          fail(`--mult wants SYM=positive-number, got '${k}=${v}'`);
        multipliers[k] = n;
      }
      const importOpts: Parameters<typeof runTradesImport>[1] = { map, multipliers };
      if (opts.broker !== undefined) importOpts.broker = opts.broker;
      if (opts.csv !== undefined) importOpts.csv = opts.csv;
      await runTradesImport(ctx, importOpts);
    } catch (err) {
      handleError(err);
    } finally {
      await ctx.store.close();
    }
  });

trades
  .command("status", { isDefault: true })
  .description("show the trade tags currently in the store")
  .action(async () => {
    const ctx = await openContext(dirOpt());
    try {
      runTradesStatus(ctx);
    } finally {
      await ctx.store.close();
    }
  });

program
  .command("export")
  .description("export bars, sessions, events, or a query's matches: it's your disk")
  .option("--table <table>", "bars | sessions | events")
  .option("--query <dsl>", "export the feature rows matching a DSL query")
  .option("--symbol <symbol>", "symbol (required with --query)")
  .option("--session <key>", "session window (with --query)")
  .option("--since <date>")
  .option("--until <date>")
  .requiredOption("--out <path>", "output file (.csv or .parquet)")
  .action(async (opts: Record<string, string | undefined>) => {
    const ctx = await openContext(dirOpt());
    try {
      const out = String(opts.out);
      const format: ExportFormat = out.endsWith(".parquet") ? "parquet" : "csv";
      if (opts.table) {
        const table = String(opts.table);
        if (table !== "bars" && table !== "sessions" && table !== "events") {
          fail(`--table wants bars | sessions | events, got '${table}'`);
        }
        const summary = await exportTable(ctx.store, table, out, format, opts.symbol);
        console.log(`${summary.rows} rows → ${summary.path}`);
      } else if (opts.query) {
        if (!opts.symbol) fail("--query needs --symbol");
        const summary = await exportQuery(
          ctx.store,
          ctx.config,
          {
            dsl: String(opts.query),
            symbol: String(opts.symbol),
            sessionKey: opts.session,
            since: opts.since,
            until: opts.until,
          },
          out,
          format,
        );
        console.log(`${summary.rows} rows → ${summary.path}`);
      } else {
        fail("pass --table or --query");
      }
    } catch (err) {
      handleError(err, opts.query);
    } finally {
      await ctx.store.close();
    }
  });

program
  .command("calendar")
  .description("show resolved session windows (holidays, half days, DST all applied)")
  .requiredOption("--symbol <symbol>", "symbol")
  .requiredOption("--from <date>", "ISO date")
  .requiredOption("--to <date>", "ISO date")
  .option("--session <key>", "session window (default: the symbol default)")
  .action(async (opts: { symbol: string; from: string; to: string; session?: string }) => {
    const ctx = await openContext(dirOpt());
    try {
      const symbol = findSymbol(ctx.config, opts.symbol);
      const resolver = makeSessionResolver(ctx.config, ctx.dataDir);
      const key = opts.session ?? (await import("@luxalgo/edge-stats")).defaultSessionKey(symbol);
      const windows = resolver.resolve(symbol, key, opts.from, opts.to);
      for (const w of windows) {
        const half = w.isHalfDay ? pc.yellow(" HALF DAY") : "";
        console.log(
          `${w.tradeDate}  ${new Date(w.startMs).toISOString()} → ${new Date(w.endMs).toISOString()}${half}`,
        );
      }
      console.log(pc.dim(`${windows.length} sessions (${opts.symbol} ${key})`));
    } catch (err) {
      handleError(err);
    } finally {
      await ctx.store.close();
    }
  });

program
  .command("freshness")
  .description("per-symbol bar watermarks, calendar versions and coverage horizons")
  .option("--json", "emit JSON", false)
  .action(async (opts: { json: boolean }) => {
    const ctx = await openContext(dirOpt());
    try {
      const report = await freshness(ctx.store, ctx.config);
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      for (const s of report.symbols) {
        console.log(
          `${s.symbol.padEnd(12)} ${s.tf.padEnd(4)} ${s.adapter.padEnd(10)} last bar: ${s.lastBar ?? "—"}`,
        );
      }
      for (const c of report.calendars) {
        console.log(
          pc.dim(
            `calendar ${c.exchange} v${c.version} covers ${c.coverage.from} → ${c.coverage.to}`,
          ),
        );
      }
      console.log(pc.dim(`store ${report.storeFingerprint} · engine ${report.engineVersion}`));
    } finally {
      await ctx.store.close();
    }
  });

program
  .command("serve")
  .description("serve the local dashboard + API (localhost only by default)")
  .option("--port <port>", "port")
  .option("--host <host>", "host")
  .action(async (opts: { port?: string; host?: string }) => {
    const ctx = await openContext(dirOpt());
    startServer(
      ctx,
      opts.port ? Number(opts.port) : ctx.config.serve.port,
      opts.host ?? ctx.config.serve.host,
    );
  });

const live = program
  .command("live")
  .description(
    "the Live Board: evaluate watches against the developing session, alert through sinks",
  );
live
  .option("--once", "run a single evaluation pass, print the setups, and exit", false)
  .option("--interval <sec>", "override the configured evaluation interval for this run")
  .option("--no-sync", "skip the per-tick bar sync (evaluate the store as-is)")
  .action(async (opts: { once: boolean; interval?: string; sync: boolean }) => {
    let intervalSec: number | undefined;
    if (opts.interval !== undefined) {
      intervalSec = Number(opts.interval);
      if (!Number.isFinite(intervalSec) || intervalSec < 1) {
        fail(`--interval wants a positive number of seconds, got '${opts.interval}'`);
      }
    }
    const ctx = await openContext(dirOpt());
    try {
      if (opts.once) {
        await runLiveOnce(ctx, { sync: opts.sync });
      } else {
        await runLiveWatch(ctx, { sync: opts.sync, intervalSec });
      }
    } catch (err) {
      handleError(err);
    } finally {
      await ctx.store.close();
    }
  });
live
  .command("alerts")
  .description("list fired alerts (each one stored its full evaluation snapshot)")
  .option("--limit <n>", "max alerts to list", "50")
  .action(async (opts: { limit: string }) => {
    const ctx = await openContext(dirOpt());
    try {
      await runLiveAlerts(ctx, Number(opts.limit));
    } catch (err) {
      handleError(err);
    } finally {
      await ctx.store.close();
    }
  });
live
  .command("replay")
  .description("re-print the stored evaluation snapshot behind a fired alert")
  .argument("<id>", "alert id (from `edgestats live alerts`)")
  .action(async (id: string) => {
    const ctx = await openContext(dirOpt());
    try {
      await runLiveReplay(ctx, id);
    } catch (err) {
      handleError(err);
    } finally {
      await ctx.store.close();
    }
  });

program
  .command("bench")
  .description("time the query battery against the current store (the interactivity gate)")
  .option("--max-ms <ms>", "per-query budget", "3000")
  .option("--json", "emit JSON", false)
  .action(async (opts: { maxMs: string; json: boolean }) => {
    const ctx = await openContext(dirOpt());
    try {
      await runBench(ctx, Number(opts.maxMs), opts.json);
    } catch (err) {
      handleError(err);
    } finally {
      await ctx.store.close();
    }
  });

// A tiny epilogue so `edgestats` with no args teaches the flow.
program.addHelpText(
  "after",
  `
examples:
  edgestats init --demo                       zero-key demo store (synthetic bars)
  edgestats query "gapFill WHERE dayOfWeek = Tue AND gapPct BETWEEN 0.2% AND 0.6%" --symbol DEMO_STK
  edgestats report gap-fill --symbol DEMO_STK --group gapBucket
  edgestats fields                            the whole registry, with definitions
  edgestats export --query "gapFill" --symbol DEMO_STK --out fills.parquet
  edgestats serve                             dashboard + API on localhost
  edgestats live --once                       evaluate the Live Board watches once

every estimate ships with N and a 95% CI: ${pc.dim("frequencies, not forecasts.")}`,
);

program.parseAsync(process.argv).catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});

export { pct };
