/*
  MCP server context: one store per process, opened lazily from
  EDGESTATS_DIR (or cwd). The server is a thin veneer over core — every
  tool answers from the same engine the CLI and dashboard use.
*/
import type { EdgeStatsConfig, Preset, Store } from "@luxalgo/edge-stats";
import { Store as StoreImpl, loadConfig, loadPresets, presetsDir } from "@luxalgo/edge-stats";

export interface McpContext {
  config: EdgeStatsConfig;
  dataDir: string;
  store: Store;
  presets: Preset[];
}

let cached: Promise<McpContext> | null = null;

export function getContext(): Promise<McpContext> {
  if (cached) return cached;
  cached = (async () => {
    const dir = process.env.EDGESTATS_DIR ?? process.cwd();
    const loaded = loadConfig(dir);
    const store = await StoreImpl.open(loaded.dataDir);
    return {
      config: loaded.config,
      dataDir: loaded.dataDir,
      store,
      presets: loadPresets(presetsDir(loaded.dataDir)),
    };
  })();
  return cached;
}
