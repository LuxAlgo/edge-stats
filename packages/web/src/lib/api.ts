/*
  Typed same-origin client for the `edgestats serve` API. Every type comes
  from the engine itself via type-only imports — nothing from core lands in
  the browser bundle, but the dashboard consumes the exact same envelope
  the CLI and the MCP server emit.
*/
import type {
  FreshnessReport,
  LiveSetupState,
  Preset,
  PresetRunRequest,
  PresetRunResult,
  QueryRequest,
  QueryResult,
  RegistryEntryDescription,
  SessionDetail,
  SymbolConfig,
} from "@luxalgo/edge-stats";

export type {
  DistributionSummary,
  FreshnessReport,
  GroupResult,
  GuardResult,
  LiveSetupState,
  Preset,
  PresetParam,
  PresetRunRequest,
  PresetRunResult,
  QueryRequest,
  QueryResult,
  RecencyView,
  RegistryEntryDescription,
  SessionDetail,
  SessionRef,
  StabilitySplit,
  SymbolConfig,
} from "@luxalgo/edge-stats";

/** One argument spec of a registry predicate/outcome, as served by /api/registry. */
export type RegistryArg = NonNullable<RegistryEntryDescription["args"]>[number];

export interface HealthResponse {
  ok: boolean;
  fingerprint: string;
}

export interface AdapterInfo {
  id: string;
  title: string;
  doc: string;
  requiresEnv: string[];
}

export interface LiveStateResponse {
  enabled: boolean;
  setups: LiveSetupState[];
}

interface ApiErrorBody {
  error: string;
  hint?: string | null;
  position?: number;
  length?: number;
}

/** A structured API error: message plus the engine's hint and, for DSL syntax errors, the exact offset. */
export class ApiError extends Error {
  readonly status: number;
  readonly hint: string | null;
  readonly position: number | null;
  readonly length: number | null;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error);
    this.name = "ApiError";
    this.status = status;
    this.hint = body.hint ?? null;
    this.position = typeof body.position === "number" ? body.position : null;
    this.length = typeof body.length === "number" ? body.length : null;
  }
}

async function request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { ...init, signal: signal ?? null });
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const candidate = body as ApiErrorBody | null;
    if (candidate && typeof candidate.error === "string") throw new ApiError(res.status, candidate);
    throw new ApiError(res.status, { error: `request failed with HTTP ${res.status}` });
  }
  return body as T;
}

function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {}, signal);
}

function post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    signal,
  );
}

export const api = {
  health: (signal?: AbortSignal) => get<HealthResponse>("/api/health", signal),
  registry: (signal?: AbortSignal) =>
    get<{ entries: RegistryEntryDescription[] }>("/api/registry", signal),
  symbols: (signal?: AbortSignal) => get<{ symbols: SymbolConfig[] }>("/api/symbols", signal),
  presets: (signal?: AbortSignal) => get<{ presets: Preset[] }>("/api/presets", signal),
  freshness: (signal?: AbortSignal) => get<FreshnessReport>("/api/freshness", signal),
  adapters: (signal?: AbortSignal) => get<{ adapters: AdapterInfo[] }>("/api/adapters", signal),
  liveState: (signal?: AbortSignal) => get<LiveStateResponse>("/api/live/state", signal),
  query: (body: QueryRequest, signal?: AbortSignal) =>
    post<QueryResult>("/api/query", body, signal),
  preset: (body: PresetRunRequest, signal?: AbortSignal) =>
    post<PresetRunResult>("/api/preset", body, signal),
  sessions: (ids: string[], signal?: AbortSignal) =>
    post<{ sessions: SessionDetail[] }>("/api/sessions", { ids }, signal),
};
