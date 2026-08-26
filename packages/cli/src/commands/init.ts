/*
  `edgestats init [--demo]`: the 60-second path. Writes the config, copies
  the packaged calendars / events / presets into the data directory (a store
  is self-contained: it knows exactly which calendar data it derived with),
  and with --demo generates deterministic synthetic bars and syncs them so
  the very next command can be a query. Zero keys, zero accounts.
*/
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONFIG_FILENAME,
  Store,
  parseConfig,
  syncSymbols,
  type EdgeStatsConfig,
} from "@luxalgo/edge-stats";
import { packagedDataRoot } from "../context";

function copyJsonDir(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let count = 0;
  for (const name of readdirSync(from)) {
    if (!name.endsWith(".json")) continue;
    copyFileSync(join(from, name), join(to, name));
    count += 1;
  }
  return count;
}

export function demoConfig(): EdgeStatsConfig {
  return {
    dataDir: ".edge-stats",
    minN: { warn: 30, refuse: 10 },
    recencyWindow: 250,
    serve: { port: 3343, host: "127.0.0.1" },
    symbols: [
      {
        symbol: "DEMO_STK",
        adapter: "synthetic",
        assetClass: "equity",
        tf: "1m",
        orWindows: [5, 10, 15, 30, 60],
        ibWindow: 60,
        adapterOptions: { profile: "equity", seed: 42 },
      },
      {
        symbol: "DEMO_FUT",
        adapter: "synthetic",
        assetClass: "future",
        tf: "1m",
        orWindows: [5, 10, 15, 30, 60],
        ibWindow: 60,
        adapterOptions: { profile: "future", seed: 1337 },
      },
    ],
  } as EdgeStatsConfig;
}

function emptyConfig(): EdgeStatsConfig {
  return {
    dataDir: ".edge-stats",
    minN: { warn: 30, refuse: 10 },
    recencyWindow: 250,
    serve: { port: 3343, host: "127.0.0.1" },
    symbols: [],
  } as EdgeStatsConfig;
}

export interface InitOptions {
  dir: string;
  demo: boolean;
  force: boolean;
  quiet: boolean;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const log = opts.quiet ? () => {} : (msg: string) => console.log(msg);
  const dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, CONFIG_FILENAME);
  if (existsSync(configPath) && !opts.force) {
    throw new Error(`${configPath} already exists: pass --force to overwrite`);
  }
  const config = opts.demo ? demoConfig() : emptyConfig();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const loaded = parseConfig(JSON.parse(JSON.stringify(config)), configPath);

  const dataRoot = packagedDataRoot();
  const calendars = copyJsonDir(
    join(dataRoot, "data", "holidays"),
    join(loaded.dataDir, "calendar"),
  );
  const events = copyJsonDir(join(dataRoot, "data", "events"), join(loaded.dataDir, "events"));
  const presets = copyJsonDir(join(dataRoot, "presets"), join(loaded.dataDir, "presets"));
  log(`wrote ${configPath}`);
  log(
    `data dir ${loaded.dataDir} (${calendars} calendars, ${events} event files, ${presets} presets)`,
  );

  if (opts.demo) {
    log("generating demo bars (synthetic, seeded: not real market data)…");
    const store = await Store.open(loaded.dataDir);
    try {
      const summary = await syncSymbols(store, loaded.config, {
        log: opts.quiet ? undefined : log,
      });
      for (const s of summary.symbols) log(`  ${s.symbol}: ${s.barsInserted} bars`);
      log("demo store ready. Try:");
      log('  edgestats query "gapFill WHERE dayOfWeek = Tue" --symbol DEMO_STK');
      log("  edgestats report gap-fill --symbol DEMO_STK --group dayOfWeek");
      log("  edgestats serve");
    } finally {
      await store.close();
    }
  } else {
    log("config written. Add symbols to edge-stats.config.json, then run `edgestats sync`.");
    log("adapters available: run `edgestats adapters`");
  }
}
