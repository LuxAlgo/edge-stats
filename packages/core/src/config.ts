import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";

const HHMM = /^([01]\d|2[0-4]):[0-5]\d$/;

export const sessionDefSchema = z.object({
  /** Session open, exchange-local wall clock (HH:MM). */
  start: z.string().regex(HHMM),
  /** Session close, exchange-local wall clock (HH:MM); '24:00' = end of day. */
  end: z.string().regex(HHMM),
  /** IANA timezone the wall-clock times live in (DST handled from here). */
  tz: z.string(),
  /** True when the session opens on the calendar day before its trade date (e.g. Globex 18:00 → 17:00). */
  overnight: z.boolean().default(false),
});
export type SessionDef = z.infer<typeof sessionDefSchema>;

export const symbolConfigSchema = z.object({
  symbol: z.string().min(1),
  adapter: z.string().min(1),
  assetClass: z.enum(["equity", "future", "crypto", "forex"]),
  /** Which holiday/session calendar to use. Defaults by asset class. */
  exchange: z.enum(["NYSE", "CME", "CRYPTO", "FX"]).optional(),
  /** The session queries run against unless told otherwise. */
  defaultSession: z.string().optional(),
  /** Extra or overriding session windows, keyed by session name. */
  sessions: z.record(z.string(), sessionDefSchema).optional(),
  tf: z.string().default("1m"),
  /** Opening-range windows (minutes) derived at sync — any window here is queryable. */
  orWindows: z.array(z.number().int().positive()).default([5, 10, 15, 30, 60]),
  /** Initial-balance window (minutes). */
  ibWindow: z.number().int().positive().default(60),
  adapterOptions: z.record(z.string(), z.unknown()).default({}),
});
export type SymbolConfig = z.infer<typeof symbolConfigSchema>;

export const configSchema = z.object({
  $schema: z.string().optional(),
  dataDir: z.string().default(".edge-stats"),
  /** Statistical honesty floors: below `warn` results carry a LOW SAMPLE banner; below `refuse` no estimate is shown. */
  minN: z
    .object({
      warn: z.number().int().positive().default(30),
      refuse: z.number().int().nonnegative().default(10),
    })
    .default({ warn: 30, refuse: 10 }),
  /** Rolling window (sessions) for the recency view shown next to all-history. */
  recencyWindow: z.number().int().positive().default(250),
  symbols: z.array(symbolConfigSchema).default([]),
  serve: z
    .object({
      port: z.number().int().default(3343),
      host: z.string().default("127.0.0.1"),
    })
    .default({ port: 3343, host: "127.0.0.1" }),
  /** Live Board configuration — parsed by the live module. */
  live: z.unknown().optional(),
});
export type EdgeStatsConfig = z.infer<typeof configSchema>;

export const CONFIG_FILENAME = "edge-stats.config.json";

export interface LoadedConfig {
  config: EdgeStatsConfig;
  configPath: string;
  /** Directory the config lives in; dataDir resolves against it. */
  rootDir: string;
  /** Absolute data directory. */
  dataDir: string;
}

export function defaultSessionKey(symbol: SymbolConfig): string {
  if (symbol.defaultSession) return symbol.defaultSession;
  switch (symbol.assetClass) {
    case "equity":
      return "rth";
    case "future":
      return "rth";
    case "crypto":
      return "utc";
    case "forex":
      return "london";
  }
}

export function defaultExchange(symbol: SymbolConfig): "NYSE" | "CME" | "CRYPTO" | "FX" {
  if (symbol.exchange) return symbol.exchange;
  switch (symbol.assetClass) {
    case "equity":
      return "NYSE";
    case "future":
      return "CME";
    case "crypto":
      return "CRYPTO";
    case "forex":
      return "FX";
  }
}

export function parseConfig(json: unknown, configPath: string): LoadedConfig {
  const config = configSchema.parse(json);
  const rootDir = dirname(resolve(configPath));
  return {
    config,
    configPath: resolve(configPath),
    rootDir,
    dataDir: resolve(rootDir, config.dataDir),
  };
}

export function loadConfig(dir?: string): LoadedConfig {
  const base = resolve(dir ?? process.cwd());
  const configPath = resolve(base, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `no ${CONFIG_FILENAME} found in ${base} — run \`edgestats init\` first, or pass --dir`,
    );
  }
  return parseConfig(JSON.parse(raw), configPath);
}

export function findSymbol(config: EdgeStatsConfig, symbol: string): SymbolConfig {
  const found = config.symbols.find((s) => s.symbol === symbol);
  if (!found) {
    const available = config.symbols.map((s) => s.symbol).join(", ") || "(none configured)";
    throw new Error(`unknown symbol '${symbol}' — configured symbols: ${available}`);
  }
  return found;
}

export function parseTfMs(tf: string): number {
  const m = /^(\d+)(m|h|d)$/.exec(tf);
  if (!m) throw new Error(`unsupported timeframe '${tf}' (use e.g. 1m, 5m, 30m, 1h)`);
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}
