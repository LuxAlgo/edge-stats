/*
  `edgestats trades`: turn your own executed trades into day tags
  (TRADED, TRADED_WIN, TRADED_LOSS) so every report and query can
  condition on your real participation.

  Fills come from @luxalgo/broker-sdk (read-only: this file must never
  import `@luxalgo/broker-sdk/orders`, the experimental write layer) or
  from a broker statement CSV. Credentials are read from environment
  variables and passed straight to the broker; nothing is stored, and
  nothing leaves this machine except the broker API call itself.
*/
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import pc from "picocolors";
import {
  buildTradeTags,
  defaultSessionKey,
  loadEventFiles,
  makeSessionResolver,
  tradeTagsIn,
  writeTradeTags,
  type EventFile,
  type SessionWindow,
  type TradeFill,
} from "@luxalgo/edge-stats";
import { connect, listBrokers, type BrokerId, type Trade } from "@luxalgo/broker-sdk";
import { parseStatementCsv } from "@luxalgo/broker-sdk/csv";
import type { CliContext } from "../context";
import { fail } from "../render";

export interface TradesImportOptions {
  broker?: string;
  csv?: string;
  map: Record<string, string>;
  multipliers: Record<string, number>;
}

/** KRAKEN + apiSecret -> KRAKEN_API_SECRET; crypto-com + apiKey -> CRYPTO_COM_API_KEY. */
export function credentialEnvName(brokerId: string, fieldKey: string): string {
  const snake = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/-/g, "_")
      .toUpperCase();
  return `${snake(brokerId)}_${snake(fieldKey)}`;
}

/** Resolve a broker's credential fields from the environment, or explain exactly what is missing. */
export function credentialsFromEnv(brokerId: string): {
  brokerId: BrokerId;
  credentials: Record<string, string>;
} {
  const info = listBrokers().find((b) => b.id === brokerId);
  if (!info) {
    const ids = listBrokers()
      .map((b) => b.id)
      .join(", ");
    fail(`unknown broker '${brokerId}'. Supported: ${ids}`);
  }
  const credentials: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of info.credentials) {
    const env = credentialEnvName(info.id, field.key);
    const value = process.env[env];
    if (value === undefined || value === "") missing.push(env);
    else credentials[field.key] = value;
  }
  if (missing.length > 0) {
    fail(
      `missing credentials for ${info.displayName}: set ${missing.join(", ")}\n` +
        `read-only setup: ${info.readOnlySetup}`,
    );
  }
  return { brokerId: info.id, credentials };
}

async function fetchBrokerFills(broker: string): Promise<{ fills: TradeFill[]; source: string }> {
  const { brokerId, credentials } = credentialsFromEnv(broker);
  const connection = connect({
    broker: brokerId,
    credentials: credentials as never,
  });
  const snapshot = await connection.fetchSnapshot();
  const fills: TradeFill[] = snapshot.accounts.flatMap((account) =>
    account.trades.map((t: Trade) => ({
      symbol: t.symbol,
      side: t.side,
      quantity: t.quantity,
      price: t.price,
      ...(t.fee !== undefined ? { fee: t.fee } : {}),
      ...(t.executedAt !== undefined ? { executedAt: t.executedAt } : {}),
    })),
  );
  return {
    fills,
    source: `broker:${brokerId} via @luxalgo/broker-sdk (${snapshot.accounts.length} account(s), fetched ${snapshot.fetchedAt})`,
  };
}

function fillsFromCsv(path: string): { fills: TradeFill[]; source: string } {
  const parsed = parseStatementCsv(readFileSync(path, "utf8"));
  if (parsed.trades.length === 0) {
    fail(
      `no trades recognized in ${path}. The statement needs symbol, side, quantity, and price columns.`,
    );
  }
  if (parsed.skippedRows > 0) {
    console.log(pc.dim(`${parsed.skippedRows} unparseable row(s) skipped`));
  }
  const fills: TradeFill[] = parsed.trades.map((t: Trade) => ({
    symbol: t.symbol,
    side: t.side,
    quantity: t.quantity,
    price: t.price,
    ...(t.fee !== undefined ? { fee: t.fee } : {}),
    ...(t.executedAt !== undefined ? { executedAt: t.executedAt } : {}),
  }));
  return { fills, source: `statement:${basename(path)} (${parsed.contentHash})` };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function runTradesImport(ctx: CliContext, opts: TradesImportOptions): Promise<void> {
  if ((opts.broker === undefined) === (opts.csv === undefined)) {
    fail("pass exactly one source: --broker <id> or --csv <statement.csv>");
  }
  const { fills, source } =
    opts.broker !== undefined
      ? await fetchBrokerFills(opts.broker)
      : fillsFromCsv(String(opts.csv));
  if (fills.length === 0) fail("the source returned no trades");

  // Resolve session windows per store symbol across the fill span (padded
  // so the day-assignment rule always has an upcoming session to land on).
  const stamps = fills
    .map((f) => (f.executedAt === undefined ? Number.NaN : Date.parse(f.executedAt)))
    .filter((t) => !Number.isNaN(t));
  if (stamps.length === 0) fail("none of the trades carry a timestamp, so none can be day-tagged");
  const from = isoDay(Math.min(...stamps) - 7 * 86_400_000);
  const importedOn = isoDay(Date.now());
  const to = isoDay(
    Math.max(Date.parse(`${importedOn}T00:00:00Z`), Math.max(...stamps)) + 5 * 86_400_000,
  );

  const resolver = makeSessionResolver(ctx.config, ctx.store.dataDir);
  const windowsBySymbol: Record<string, SessionWindow[]> = {};
  for (const symbol of ctx.config.symbols) {
    windowsBySymbol[symbol.symbol] = resolver.resolve(symbol, defaultSessionKey(symbol), from, to);
  }

  const result = buildTradeTags({
    fills,
    windowsBySymbol,
    map: opts.map,
    multipliers: opts.multipliers,
    source,
    importedOn,
  });
  if (result.counts.tagged === 0) {
    const known = Object.keys(windowsBySymbol).join(", ");
    fail(
      `no fills matched a configured symbol (store symbols: ${known}).\n` +
        `Map broker symbols with --map, e.g. --map ESU6=ES`,
    );
  }
  await writeTradeTags(ctx.store, result.events);

  const c = result.counts;
  console.log(
    `${pc.bold("trades imported")}  ${c.tagged}/${c.fills} fills tagged on ${result.symbols.join(", ")}`,
  );
  console.log(
    `  days: ${c.tradedDays} traded · ${c.winDays} win · ${c.lossDays} loss` +
      `${c.tradedDays - c.winDays - c.lossDays > 0 ? ` · ${c.tradedDays - c.winDays - c.lossDays} flat/open` : ""}`,
  );
  const skips: string[] = [];
  if (c.skippedNoTimestamp > 0) skips.push(`${c.skippedNoTimestamp} without timestamps`);
  if (c.skippedNoSymbol > 0)
    skips.push(`${c.skippedNoSymbol} with unmapped symbols (--map FROM=TO)`);
  if (c.skippedOutOfRange > 0) skips.push(`${c.skippedOutOfRange} outside known sessions`);
  if (skips.length > 0) console.log(pc.yellow(`  skipped: ${skips.join(" · ")}`));
  console.log(pc.dim("\n  ask it something:"));
  console.log(
    pc.dim(
      `    edgestats query "eventOccurs('TRADED_WIN') WHERE eventDay('TRADED')" --symbol ${result.symbols[0]}`,
    ),
  );
  console.log(
    pc.dim(`    edgestats query "gapFill WHERE eventDay('TRADED')" --symbol ${result.symbols[0]}`),
  );
}

export function runTradesStatus(ctx: CliContext): void {
  const tags = tradeTagsIn(loadEventFiles(ctx.store.dataDir));
  if (tags.length === 0) {
    console.log("no trades imported yet");
    console.log(pc.dim("  edgestats trades import --broker <id>     (env credentials)"));
    console.log(pc.dim("  edgestats trades import --csv fills.csv   (broker statement)"));
    console.log(
      pc.dim(
        "  brokers: " +
          listBrokers()
            .map((b) => b.id)
            .join(", "),
      ),
    );
    return;
  }
  for (const ev of tags) {
    printEvent(ev);
  }
  console.log(
    pc.dim(
      "\ncondition anything on these: eventDay('TRADED') as a filter, eventOccurs('TRADED_WIN') as an outcome",
    ),
  );
}

function printEvent(ev: EventFile): void {
  console.log(
    `${pc.bold(ev.event.padEnd(12))} ${String(ev.dates.length).padStart(4)} day(s)  ${ev.coverage.from} → ${ev.coverage.to}`,
  );
  console.log(pc.dim(`  ${ev.sources.join("; ")}`));
}
