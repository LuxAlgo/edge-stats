/*
  @luxalgo/edge-stats — the open-source trading-statistics engine.

  Every report is one query: P(outcome | conditions), computed over the
  user's own bars in a local DuckDB store, with N, Wilson confidence
  intervals, minimum-sample guards, and stability splits on every result.
*/
export { ENGINE_VERSION } from "./version";

// config
export * from "./config";

// calendar
export * from "./calendar";

// store
export { Store } from "./store/store";
export type { BarRow, IngestResult } from "./store/store";

// registry
export * from "./registry";

// query: DSL ⇄ AST → SQL → honest envelope
export * from "./query/ast";
export { lex, DslSyntaxError } from "./query/lexer";
export { parseDsl, parseConditionDsl, renderDslError } from "./query/parser";
export { astToDsl, callToDsl, literalToDsl } from "./query/normalize";
export { compileQuery, compileConditionExpr, suggest } from "./query/compile";
export type { CompiledQuery } from "./query/compile";
export { runQuery, getSessions, parseRequestAst, compileCtxFor, DISCLAIMER } from "./query/execute";
export type {
  QueryRequest,
  QueryResult,
  SessionRef,
  GroupResult,
  RecencyView,
  SessionDetail,
} from "./query/execute";

export {
  getSessionBars,
  SESSION_BARS_DEFAULT_CONTEXT,
  SESSION_BARS_MAX_CONTEXT,
} from "./query/session-bars";
export type {
  SessionBar,
  SessionBarsOptions,
  SessionBarsResult,
  SessionContext,
  SessionLevels,
  SessionOpeningRange,
  SessionTimes,
} from "./query/session-bars";

export { exportQuery, exportTable } from "./query/export";
export type { ExportFormat, ExportSummary } from "./query/export";

// stats
export * from "./stats/stats";

// features
export { deriveFeatures } from "./features/derive";
export type { DeriveOptions, DeriveSummary } from "./features/derive";
export { featureColumns, featuresDdl, BASE_COLUMNS, orColumns } from "./features/schema";

// adapters
export * from "./adapters";

// presets
export * from "./presets/presets";

// events
export * from "./events";

// trade tags (fills -> day tags; pure, broker-free)
export * from "./trades";

// sync
export { syncSymbols, freshness } from "./sync";
export type { SyncOptions, SyncSummary, SymbolSyncSummary, FreshnessReport } from "./sync";

// live board contracts
export * from "./live/types";

// live board: evaluation engine, sinks, replay (types above stay the contract)
export {
  LIVE_STATE_META_KEY,
  evaluatePass,
  getLiveConfig,
  readLiveState,
  runLiveLoop,
} from "./live/board";
export type {
  EvaluatePassOptions,
  EvaluatePassResult,
  LiveLoopOptions,
  LiveState,
} from "./live/board";
export { emitAlert, formatAlertText } from "./live/sinks";
export type { SinkEnv } from "./live/sinks";
export { listAlerts, replayAlert } from "./live/replay";
export type { AlertRecord, AlertSnapshot, ListAlertsOptions } from "./live/replay";
