/*
  Live Board contracts. The evaluation engine (scheduler, developing-session
  features, alert sinks, replay) lives in live/board.ts; these types are the
  stable surface the CLI, dashboard, and MCP consume.

  Alert payloads are versioned: downstream automation (webhooks into
  self-hosted relays, chat sinks, NDJSON tails) can rely on `v` and `kind`.
  Every fired alert stores its evaluation snapshot in the store's `alerts`
  table — replayable, auditable, never a mystery number.
*/
import { z } from "zod";

export const liveWatchSchema = z.object({
  /** A preset id (with optional params) or a raw DSL query. */
  preset: z.string().optional(),
  params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  dsl: z.string().optional(),
  symbol: z.string(),
  sessionKey: z.string().optional(),
  /** Alert when the conditional estimate crosses these bounds (inclusive). */
  threshold: z
    .object({ min: z.number().min(0).max(1).optional(), max: z.number().min(0).max(1).optional() })
    .default({}),
  /** Require at least this many matched historical sessions before alerting. */
  minN: z.number().int().positive().optional(),
});
export type LiveWatch = z.infer<typeof liveWatchSchema>;

export const liveSinkSchema = z.union([
  z.object({ type: z.literal("webhook"), url: z.string().url() }),
  z.object({ type: z.literal("discord"), webhookUrlEnv: z.string() }),
  z.object({ type: z.literal("telegram"), botTokenEnv: z.string(), chatIdEnv: z.string() }),
  z.object({ type: z.literal("ndjson"), path: z.string() }),
  z.object({ type: z.literal("desktop") }),
]);
export type LiveSink = z.infer<typeof liveSinkSchema>;

export const liveConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Evaluation interval in seconds (the board recomputes from the store + adapter). */
  intervalSec: z.number().int().min(15).default(300),
  watch: z.array(liveWatchSchema).default([]),
  sinks: z.array(liveSinkSchema).default([]),
});
export type LiveConfig = z.infer<typeof liveConfigSchema>;

export type SetupPhase = "forming" | "active" | "resolved";

export interface LiveSetupState {
  id: string;
  symbol: string;
  sessionKey: string;
  tradeDate: string;
  dsl: string;
  phase: SetupPhase;
  /** The historical conditional probability given the developing session's state. */
  estimate: number | null;
  ci95: [number, number] | null;
  n: number;
  lowSample: boolean;
  evaluatedAt: string;
}

/** Versioned alert payload — the webhook body, the chat message's data, the NDJSON line. */
export interface AlertPayload {
  v: 1;
  kind: "edge-stats.alert";
  id: string;
  firedAt: string;
  symbol: string;
  sessionKey: string;
  tradeDate: string;
  dsl: string;
  estimate: number;
  ci95: [number, number];
  n: number;
  threshold: { min?: number; max?: number };
  storeFingerprint: string;
  disclaimer: string;
}
