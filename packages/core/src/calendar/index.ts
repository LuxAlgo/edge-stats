import type { EdgeStatsConfig, SymbolConfig } from "../config";
import { defaultExchange } from "../config";
import { loadHolidayCalendar } from "./data";
import { resolveSessions } from "./sessions";
import type { SessionWindow } from "./types";

export * from "./types";
export * from "./data";
export * from "./sessions";

export interface SessionResolver {
  resolve(symbol: SymbolConfig, sessionKey: string, from: string, to: string): SessionWindow[];
}

/** Resolver bound to a store's calendar data directory. */
export function makeSessionResolver(_config: EdgeStatsConfig, dataDir: string): SessionResolver {
  return {
    resolve(symbol, sessionKey, from, to) {
      const holidays =
        symbol.assetClass === "crypto"
          ? null
          : loadHolidayCalendar(dataDir, defaultExchange(symbol));
      return resolveSessions({ symbol, sessionKey, from, to, holidays });
    },
  };
}
