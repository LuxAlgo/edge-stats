/*
  Alert sinks: where a fired alert goes. Every sink is best-effort — a dead
  webhook, a missing env var, or a machine without a notification daemon
  must never take the evaluation loop down. Secrets are read from the
  environment by NAME (the config stores env var names, never values) and
  are never logged.

  The content discipline is non-negotiable: every human-readable message
  carries the estimate, the 95% CI, N, the query itself, and the
  "historical frequency, not a forecast" disclaimer. There is no compact
  form that drops the sample size.
*/
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import type { AlertPayload, LiveSink } from "./types";

export type SinkEnv = Record<string, string | undefined>;

const WEBHOOK_TIMEOUT_MS = 5000;

/** One-line warnings (e.g. missing env) print once per process, not per tick. */
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.error(message);
}

function pctText(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

/**
 * The chat-sink message line. Always includes estimate + 95% CI + N + the
 * query DSL + the disclaimer — the honesty rules apply in a notification
 * exactly as they do in a terminal.
 */
export function formatAlertText(payload: AlertPayload): string {
  return (
    `Edge Stats: ${payload.symbol} ${payload.tradeDate} (${payload.sessionKey}). ` +
    `${payload.dsl}: estimate ${pctText(payload.estimate)} ` +
    `(95% CI ${pctText(payload.ci95[0])}–${pctText(payload.ci95[1])}, N = ${payload.n}). ` +
    `historical frequency, not a forecast`
  );
}

/**
 * POST a JSON body with a timeout and one retry. Thrown messages are built
 * here and never include the URL, so a telegram token can never leak into
 * a log line.
 */
async function postJson(url: string, body: unknown): Promise<void> {
  let lastError = "request failed";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastError);
}

/** Best-effort desktop notification; every failure mode is swallowed. */
function desktopNotify(title: string, text: string): void {
  try {
    if (process.platform === "linux") {
      const child = spawn("notify-send", [title, text], { stdio: "ignore" });
      child.on("error", () => {
        /* no notification daemon — best-effort by design */
      });
      child.unref();
    } else if (process.platform === "darwin") {
      const script = `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`;
      const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
      child.on("error", () => {
        /* best-effort by design */
      });
      child.unref();
    }
  } catch {
    /* best-effort by design */
  }
}

async function emitOne(sink: LiveSink, payload: AlertPayload, env: SinkEnv): Promise<void> {
  switch (sink.type) {
    case "webhook": {
      await postJson(sink.url, payload);
      return;
    }
    case "discord": {
      const url = env[sink.webhookUrlEnv];
      if (!url) {
        warnOnce(
          `discord:${sink.webhookUrlEnv}`,
          `live: discord sink skipped: set ${sink.webhookUrlEnv} to your webhook URL`,
        );
        return;
      }
      await postJson(url, { content: formatAlertText(payload) });
      return;
    }
    case "telegram": {
      const token = env[sink.botTokenEnv];
      const chatId = env[sink.chatIdEnv];
      if (!token || !chatId) {
        warnOnce(
          `telegram:${sink.botTokenEnv}:${sink.chatIdEnv}`,
          `live: telegram sink skipped: set ${sink.botTokenEnv} and ${sink.chatIdEnv}`,
        );
        return;
      }
      await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: formatAlertText(payload),
      });
      return;
    }
    case "ndjson": {
      mkdirSync(dirname(sink.path), { recursive: true });
      appendFileSync(sink.path, `${JSON.stringify(payload)}\n`);
      return;
    }
    case "desktop": {
      desktopNotify(`Edge Stats: ${payload.symbol} ${payload.tradeDate}`, formatAlertText(payload));
      return;
    }
  }
}

/**
 * Emit one alert payload to every configured sink. Never throws: a failing
 * sink logs one line (never a token or URL-with-token) and the rest of the
 * sinks still get the alert.
 */
export async function emitAlert(
  sinks: LiveSink[],
  payload: AlertPayload,
  env: SinkEnv,
): Promise<void> {
  for (const sink of sinks) {
    try {
      await emitOne(sink, payload, env);
    } catch (err) {
      console.error(
        `live: ${sink.type} sink failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
