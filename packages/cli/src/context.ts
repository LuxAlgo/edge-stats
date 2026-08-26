import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EdgeStatsConfig, Preset } from "@luxalgo/edge-stats";
import { Store, loadConfig, loadPresets, presetsDir } from "@luxalgo/edge-stats";

export interface CliContext {
  config: EdgeStatsConfig;
  configPath: string;
  rootDir: string;
  dataDir: string;
  store: Store;
  presets: Preset[];
}

export async function openContext(dir?: string): Promise<CliContext> {
  const loaded = loadConfig(dir);
  const store = await Store.open(loaded.dataDir);
  const presets = loadPresets(presetsDir(loaded.dataDir));
  return {
    config: loaded.config,
    configPath: loaded.configPath,
    rootDir: loaded.rootDir,
    dataDir: loaded.dataDir,
    store,
    presets,
  };
}

/**
 * The repo/package data root that `edgestats init` copies calendars,
 * events, and presets from. Overridable with EDGESTATS_DATA_ROOT (set it
 * when running from a global install against a checked-out data folder).
 */
export function packagedDataRoot(): string {
  const override = process.env.EDGESTATS_DATA_ROOT;
  if (override) return override;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
