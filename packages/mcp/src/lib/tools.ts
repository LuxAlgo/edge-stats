/*
  The edge_* tool surface. Read-only over the local store; results are
  compact JSON in text content; every estimate ships inside the honest
  envelope (N, Wilson CI, guards, stability) — an agent that repeats a
  number without its sample size is quoting us out of context, and the
  envelope makes that visible.

  Tool flow the descriptions teach: edge_freshness first (symbols,
  staleness); edge_fields → edge_query → edge_sessions (receipts).
  Presets: edge_reports_list → edge_report. Out the side: edge_export
  (files on the user's own disk) and edge_live (the Live Board seam).
*/
import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExportFormat } from "@luxalgo/edge-stats";
import {
  DslSyntaxError,
  QueryError,
  defaultSessionKey,
  describeRegistry,
  exportQuery,
  exportTable,
  findSymbol,
  freshness,
  getSessions,
  libraryUrl,
  runPreset,
  runQuery,
} from "@luxalgo/edge-stats";
import { getContext } from "../context";

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** The disabled Live Board shape: also the fallback for a missing or unparseable seam. */
function liveDisabled() {
  return {
    enabled: false,
    setups: [] as unknown[],
    note: "Live Board not running — enable live in edge-stats.config.json and run `edgestats live`",
  };
}

/**
 * Exports land inside <dataDir>/exports only. Absolute paths and directory
 * separators never survive: everything outside [a-z0-9-_.] becomes '-',
 * leading dots/dashes are stripped (no '..', no hidden files), and the
 * extension is forced to match the format.
 */
function safeExportFilename(requested: string | undefined, format: ExportFormat): string {
  const ext = `.${format}`;
  const cleaned = (requested ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, 100);
  const base = cleaned.length > 0 ? cleaned : `edge-export-${Date.now()}`;
  return base.endsWith(ext) ? base : `${base}${ext}`;
}

export function toolError(err: unknown) {
  const payload =
    err instanceof QueryError
      ? { error: err.message, hint: err.hint ?? null }
      : err instanceof DslSyntaxError
        ? { error: err.message, hint: err.hint ?? null, position: err.pos, length: err.len }
        : { error: err instanceof Error ? err.message : String(err) };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
}

export function registerEdgeTools(server: McpServer): void {
  server.registerTool(
    "edge_query",
    {
      title: "Run a conditional-probability query",
      description:
        "Compute P(outcome | conditions) over the local bar store: any outcome from the registry, conditioned on any composable predicate expression. " +
        "Pass `dsl` like \"gapFill WHERE dayOfWeek = Tue AND gapPct BETWEEN 0.2% AND 0.6% AND NOT eventDay('FOMC')\" — or the equivalent JSON `ast`. " +
        "Every result is an honest envelope: point estimate, N, Wilson 95% CI, minimum-sample guards (estimates below the refuse floor are withheld), a first-half/second-half stability split, per-year counts, a recency view, a value distribution where the outcome has one (e.g. minutes-to-fill), and the normalized query echoed back so you can catch mis-parses. " +
        "ALWAYS report N and the CI alongside any estimate you quote. The result also lists matching session ids — hand them to edge_sessions for receipts. " +
        "Discover valid names first with edge_fields; unknown names come back with did-you-mean hints. Frequencies, not forecasts: never present these as predictions.",
      inputSchema: {
        dsl: z
          .string()
          .optional()
          .describe(
            "Query DSL: '<outcome> [WHERE <conditions>]'. Conditions compose with AND/OR/NOT, comparisons (=, !=, >, >=, <, <=), BETWEEN, IN. Units: 0.5% (percent), 15m/1h (duration). Example: \"orbBreak(15m, up) WHERE gapUp AND NOT eventDay('CPI')\"",
          ),
        ast: z
          .unknown()
          .optional()
          .describe(
            "The JSON AST form (see edge_fields for names; the envelope echoes the AST it ran)",
          ),
        symbol: z
          .string()
          .describe("Configured symbol, e.g. 'NQ' — see edge_freshness for the list"),
        sessionKey: z
          .string()
          .optional()
          .describe(
            "Session window: 'rth', 'globex', a custom key — default is the symbol's default",
          ),
        since: z.string().optional().describe("ISO date lower bound, e.g. 2019-01-01"),
        until: z.string().optional().describe("ISO date upper bound"),
        groupBy: z
          .string()
          .optional()
          .describe(
            "Group by a groupable field ('dayOfWeek', 'gapBucket', 'month', …) — one envelope per group",
          ),
        sessionsLimit: z
          .number()
          .int()
          .min(0)
          .max(500)
          .optional()
          .describe("How many matching session refs to return (default 25)"),
        force: z
          .boolean()
          .optional()
          .describe("Return the estimate even below the refuse floor (guards still flag it)"),
      },
    },
    async (args) => {
      try {
        const ctx = await getContext();
        const result = await runQuery(ctx.store, ctx.config, {
          dsl: args.dsl,
          ast: args.ast,
          symbol: args.symbol,
          sessionKey: args.sessionKey,
          since: args.since,
          until: args.until,
          groupBy: args.groupBy,
          sessionsLimit: args.sessionsLimit,
          force: args.force,
        });
        return json(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "edge_fields",
    {
      title: "The registry: fields, predicates, outcomes",
      description:
        "The single source of truth behind every query: all outcomes (the measured events — gapFill, orbBreak, touchPrevHigh, hit, …), predicates (composable conditions — eventDay, streak, fvgPresent, orbBroke, …), and fields (comparable values — gapPct, dayOfWeek, rangeVsAtr, …), each with its definition, argument spec, examples, and — where the concept mirrors the LuxAlgo Library — a canonical citation URL. " +
        "Call this FIRST when composing queries: names are exact (the compiler suggests near-misses, but the registry is the contract). Fields marked groupable can be used as edge_query groupBy.",
      inputSchema: {
        kind: z
          .enum(["field", "predicate", "outcome"])
          .optional()
          .describe("Limit to one kind; default all"),
      },
    },
    async (args) => {
      try {
        return json({ entries: describeRegistry(args.kind) });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "edge_sessions",
    {
      title: "Drill into the sessions behind a result",
      description:
        "The receipts: full derived feature rows (OHLC, gap state, opening-range breaks, prior-level touches, streaks, event flags, …) for session ids returned by edge_query / edge_report. Use it to show WHICH historical sessions produced an estimate instead of asking anyone to trust a bare percentage. Up to 500 ids per call.",
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .max(500)
          .describe("Session ids from a query result's `sessions[].sessionId`"),
      },
    },
    async (args) => {
      try {
        const ctx = await getContext();
        return json({ sessions: await getSessions(ctx.store, args.ids) });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "edge_report",
    {
      title: "Run a preset report",
      description:
        "Run a named report from the preset catalog — the same engine as edge_query, packaged as a versioned query file with documented parameters. " +
        "Flow: edge_reports_list → pick an id and its params → edge_report. Example: {preset: 'gap-fill', symbol: 'NQ', params: {minGapPct: 0.3, dir: 'down'}} — param names, types, enum values, and defaults all come from the listing; unknown presets or params come back with hints. " +
        "The result is the same honest envelope as edge_query — point estimate, N, Wilson 95% CI, minimum-sample guards, stability split, per-year counts, value distribution, matching session ids for edge_sessions — plus preset metadata {id, version, title, params} and the composed query echoed under query.dsl. " +
        "Every preset is just a saved edge_query: when the fixed params are too coarse, take the echoed DSL, edit it, and run it raw. " +
        "ALWAYS report N and the CI alongside any estimate you quote. Frequencies, not forecasts: never present these as predictions.",
      inputSchema: {
        preset: z.string().describe("Preset id from edge_reports_list, e.g. 'gap-fill' or 'orb'"),
        symbol: z
          .string()
          .describe("Configured symbol, e.g. 'NQ' — see edge_freshness for the list"),
        params: z
          .record(z.string(), z.union([z.number(), z.string()]))
          .optional()
          .describe(
            'Preset params by name, e.g. {"minGapPct": 0.3, "dir": "down"} — names, types, enum values, and defaults come from edge_reports_list; omitted params fall back to their defaults',
          ),
        sessionKey: z
          .string()
          .optional()
          .describe(
            "Session window: 'rth', 'globex', a custom key — default is the symbol's default",
          ),
        since: z.string().optional().describe("ISO date lower bound, e.g. 2019-01-01"),
        until: z.string().optional().describe("ISO date upper bound"),
        groupBy: z
          .string()
          .optional()
          .describe(
            "Override the preset's default grouping with any groupable field from edge_fields",
          ),
        sessionsLimit: z
          .number()
          .int()
          .min(0)
          .max(500)
          .optional()
          .describe("How many matching session refs to return (default 25)"),
        force: z
          .boolean()
          .optional()
          .describe("Return the estimate even below the refuse floor (guards still flag it)"),
      },
    },
    async (args) => {
      try {
        const ctx = await getContext();
        const result = await runPreset(ctx.store, ctx.config, ctx.presets, {
          presetId: args.preset,
          symbol: args.symbol,
          params: args.params,
          sessionKey: args.sessionKey,
          since: args.since,
          until: args.until,
          groupBy: args.groupBy,
          sessionsLimit: args.sessionsLimit,
          force: args.force,
        });
        return json(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "edge_reports_list",
    {
      title: "The preset report catalog",
      description:
        "The report catalog: every preset this store serves, one entry per versioned JSON file in <dataDir>/presets — a folder, not a hard-coded menu, so presets the user adds (or the project merges by pull request) appear here automatically. " +
        "Stock categories: 'gaps', 'opening-range', 'levels'; the result's `categories` array is the live list, and `category` filters to one. " +
        "Each entry teaches exactly what edge_report accepts: id, title, category, a plain-language summary of what the number means, params (name/type/enum values/default/doc), the default groupBy, deltas (what the preset adds over a fixed-report version of the same stat), and LuxAlgo Library citations (canonical concept/indicator URLs) for the underlying idea. " +
        "Flow: edge_reports_list → edge_report {preset, symbol, params} → edge_sessions for the receipts. Every preset is also expressible as a raw edge_query — the report envelope echoes the composed DSL so you can refine it.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe(
            "Only presets in this category, e.g. 'gaps' — the result's `categories` lists what the folder currently holds",
          ),
      },
    },
    async (args) => {
      try {
        const ctx = await getContext();
        const categories = [...new Set(ctx.presets.map((p) => p.category))].sort();
        const presets = ctx.presets
          .filter((p) => !args.category || p.category === args.category)
          .map((p) => ({
            id: p.id,
            title: p.title,
            category: p.category,
            summary: p.summary,
            params: p.params.map((param) => ({
              name: param.name,
              type: param.type,
              ...(param.values ? { values: param.values } : {}),
              ...(param.default !== undefined ? { default: param.default } : {}),
              doc: param.doc,
            })),
            groupBy: p.groupBy ?? null,
            deltas: p.deltas,
            library: p.library.map((ref) => ({ ...ref, url: libraryUrl(ref) })),
          }));
        return json({ presets, categories });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "edge_freshness",
    {
      title: "Store freshness and configured symbols",
      description:
        "Call this FIRST in a session. It lists every configured symbol — the only valid `symbol` values for edge_query / edge_report / edge_export — with its timeframe, adapter, default session key, and the timestamp of the last stored bar, e.g. {symbol: 'NQ', tf: '1m', adapter: 'csv', lastBar: '2026-02-13T20:59:00.000Z', defaultSession: 'rth'}. " +
        "It also returns the receipts that pin every answer to a store state: engineVersion, the holiday calendars in use (exchange, version, coverage window), calendarHash, and storeFingerprint (same store contents ⇒ same fingerprint — every query envelope echoes it). " +
        "Read lastBar before quoting anything: a null or old lastBar means the statistics stop at that date. This server never writes bars — if the store is stale, tell the user to run `edgestats sync`, and mention the cutoff date alongside any estimate you quote from a stale store.",
      inputSchema: {},
    },
    async () => {
      try {
        const ctx = await getContext();
        const report = await freshness(ctx.store, ctx.config);
        const symbols = report.symbols.map((s) => ({
          ...s,
          defaultSession: defaultSessionKey(findSymbol(ctx.config, s.symbol)),
        }));
        return json({ ...report, symbols });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "edge_export",
    {
      title: "Export store data to a local file",
      description:
        "Write store data to a file on the user's own disk and hand back the path — nothing is uploaded anywhere; it was never not their data. Two modes, pass exactly one: " +
        "`query` + `symbol` exports the full derived feature rows matching a DSL query (same language as edge_query) with outcome_success / outcome_value columns appended — e.g. {query: \"gapFill WHERE gapDir = down\", symbol: 'NQ', filename: 'nq-down-gaps.csv'}; " +
        "`table` exports a whole table — 'bars' (raw OHLCV), 'sessions' (derived session features), or 'events' (the macro-event calendar) — e.g. {table: 'bars', symbol: 'ES', format: 'parquet'}. " +
        "Files always land inside <dataDir>/exports/ — filenames are sanitized to [a-z0-9-_.], so absolute paths and directories are refused by construction — and the result is {rows, path, format}: quote the path so the user can find the file. " +
        "Use edge_query first to size and sanity-check the result; use this when the user wants the underlying rows in a spreadsheet, notebook, or another tool.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Query DSL (same language as edge_query): export the feature rows behind it, with outcome_success/outcome_value appended. Requires `symbol`. Example: "orbBreak(15m, up) WHERE gapUp"',
          ),
        table: z
          .enum(["bars", "sessions", "events"])
          .optional()
          .describe(
            "Export a whole table instead: raw bars, derived session features, or the macro-event calendar. Mutually exclusive with `query`",
          ),
        symbol: z
          .string()
          .optional()
          .describe(
            "Required with `query`; optional filter for 'bars'/'sessions' table exports ('events' is symbol-free)",
          ),
        sessionKey: z
          .string()
          .optional()
          .describe("Query exports only: session window — default is the symbol's default"),
        since: z.string().optional().describe("Query exports only: ISO date lower bound"),
        until: z.string().optional().describe("Query exports only: ISO date upper bound"),
        format: z.enum(["csv", "parquet"]).optional().describe("Output format (default csv)"),
        filename: z
          .string()
          .optional()
          .describe(
            "Plain filename, no directories — sanitized to [a-z0-9-_.] and always written inside <dataDir>/exports/; the extension is forced to match `format`. Omit for a generated name",
          ),
      },
    },
    async (args) => {
      try {
        const ctx = await getContext();
        if (args.query !== undefined && args.table !== undefined) {
          throw new QueryError(
            "pass `query` or `table`, not both",
            "`query` exports the feature rows matching a DSL query; `table` exports a whole table",
          );
        }
        const format: ExportFormat = args.format ?? "csv";
        const exportsDir = join(ctx.dataDir, "exports");
        const filename = safeExportFilename(args.filename, format);
        const outPath = join(exportsDir, filename);
        if (!resolve(outPath).startsWith(resolve(exportsDir) + sep)) {
          throw new QueryError(
            "export filename escaped the exports directory",
            "pass a plain filename like 'gaps.csv' — the server chooses the directory",
          );
        }
        mkdirSync(exportsDir, { recursive: true });
        if (args.query !== undefined) {
          if (args.symbol === undefined) {
            throw new QueryError(
              "`symbol` is required with `query`",
              "edge_freshness lists the configured symbols",
            );
          }
          const summary = await exportQuery(
            ctx.store,
            ctx.config,
            {
              dsl: args.query,
              symbol: args.symbol,
              sessionKey: args.sessionKey,
              since: args.since,
              until: args.until,
            },
            outPath,
            format,
          );
          return json(summary);
        }
        if (args.table !== undefined) {
          if (
            args.sessionKey !== undefined ||
            args.since !== undefined ||
            args.until !== undefined
          ) {
            throw new QueryError(
              "sessionKey/since/until refine `query` exports only",
              'to export filtered session rows, pass a `query` (any outcome works, e.g. "closeGreen") instead of `table`',
            );
          }
          return json(await exportTable(ctx.store, args.table, outPath, format, args.symbol));
        }
        throw new QueryError(
          "pass one of `query` or `table`",
          "e.g. {query: \"gapFill\", symbol: 'NQ'} or {table: 'bars'}",
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "edge_live",
    {
      title: "The Live Board: current setups",
      description:
        "The Live Board: the setups the live engine is tracking for developing sessions, each with its historical conditional probability GIVEN the session's state so far — read from the store's live_state seam, written by `edgestats live` on its evaluation interval (updatedAt says when it last wrote). " +
        "Every setup carries the composed DSL, its phase (forming/active/resolved), and the estimate WITH its N, Wilson 95% CI, and a lowSample flag: never quote a setup without N and the CI, and present it as a historical frequency under matching conditions — not a forecast of this session. " +
        "Fired alerts persist in the store's alerts table with their full evaluation snapshot and are replayable via the CLI, so no number is a mystery. " +
        "If the board is not running, the result is {enabled: false, setups: []} plus a note telling the user how to start it (enable live in edge-stats.config.json, run `edgestats live`).",
      inputSchema: {},
    },
    async () => {
      try {
        const ctx = await getContext();
        const raw = await ctx.store.getMeta("live_state");
        if (raw === null) return json(liveDisabled());
        let state: unknown;
        try {
          state = JSON.parse(raw);
        } catch {
          return json(liveDisabled());
        }
        if (state === null || typeof state !== "object" || Array.isArray(state)) {
          return json(liveDisabled());
        }
        const { enabled, updatedAt, setups } = state as {
          enabled?: unknown;
          updatedAt?: unknown;
          setups?: unknown;
        };
        return json({
          enabled: enabled === true,
          updatedAt: typeof updatedAt === "string" ? updatedAt : null,
          setups: Array.isArray(setups) ? setups : [],
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
