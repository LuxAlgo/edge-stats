/*
  Sink behavior: the webhook path against a real local HTTP server (body,
  content type, one retry, no throw on failure), the chat sinks' message
  building only (no network — the content discipline is what matters), the
  ndjson appender's directory creation, and the guarantee that a missing
  env var warns once by NAME and never throws or logs a secret.
*/
import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAlert, formatAlertText, type AlertPayload } from "../../src/index";

const payload: AlertPayload = {
  v: 1,
  kind: "edge-stats.alert",
  id: "FIX_STK|2024-01-22|abc123def456",
  firedAt: "2024-01-22T17:30:00.000Z",
  symbol: "FIX_STK",
  sessionKey: "rth",
  tradeDate: "2024-01-22",
  dsl: "gapFill WHERE gapDir = down",
  estimate: 0.5714,
  ci95: [0.25, 0.8419],
  n: 7,
  threshold: { min: 0.5 },
  storeFingerprint: "deadbeef1234",
  disclaimer: "Historical conditional frequencies with sample sizes — Not predictions, not advice.",
};

interface CapturedRequest {
  body: string;
  contentType: string | undefined;
}

function startCapture(
  statuses: number[],
): Promise<{ server: Server; url: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  let call = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      requests.push({ body, contentType: req.headers["content-type"] });
      const status = statuses[Math.min(call, statuses.length - 1)] ?? 200;
      call += 1;
      res.writeHead(status).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/hook`, requests });
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("message building (chat sinks share it — no network in these tests)", () => {
  it("always carries estimate, CI, N, the query, and the disclaimer", () => {
    const text = formatAlertText(payload);
    expect(text).toContain("FIX_STK");
    expect(text).toContain("2024-01-22");
    expect(text).toContain("57.1%"); // the estimate, as a percentage
    expect(text).toContain("95% CI");
    expect(text).toContain("25.0%");
    expect(text).toContain("84.2%");
    expect(text).toContain("N = 7");
    expect(text).toContain("gapFill WHERE gapDir = down");
    expect(text).toContain("historical frequency, not a forecast");
  });
});

describe("webhook sink", () => {
  it("POSTs the v1 payload as JSON", async () => {
    const { server, url, requests } = await startCapture([200]);
    try {
      await emitAlert([{ type: "webhook", url }], payload, {});
    } finally {
      server.close();
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.contentType).toContain("application/json");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual(payload);
  });

  it("retries once on a failed response", async () => {
    const { server, url, requests } = await startCapture([500, 200]);
    try {
      await emitAlert([{ type: "webhook", url }], payload, {});
    } finally {
      server.close();
    }
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1]?.body ?? "")).toEqual(payload);
  });

  it("gives up after the retry without throwing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, url, requests } = await startCapture([500, 500]);
    try {
      await expect(emitAlert([{ type: "webhook", url }], payload, {})).resolves.toBeUndefined();
    } finally {
      server.close();
    }
    expect(requests).toHaveLength(2);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("webhook sink failed"));
  });

  it("an unreachable host never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, url } = await startCapture([200]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(emitAlert([{ type: "webhook", url }], payload, {})).resolves.toBeUndefined();
  });
});

describe("missing sink env vars", () => {
  it("discord: warns once, by env var NAME, and skips the sink", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = { type: "discord" as const, webhookUrlEnv: "TEST_DISCORD_URL_A" };
    await emitAlert([sink], payload, {});
    await emitAlert([sink], payload, {});
    const warnings = errors.mock.calls.filter((c) => String(c[0]).includes("TEST_DISCORD_URL_A"));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain("discord sink skipped");
  });

  it("telegram: warns once when either env var is missing, never logging values", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = {
      type: "telegram" as const,
      botTokenEnv: "TEST_TG_TOKEN_A",
      chatIdEnv: "TEST_TG_CHAT_A",
    };
    // Token present but chat id missing → still skipped; the token value
    // must never appear in the warning.
    const env = { TEST_TG_TOKEN_A: "super-secret-token-value" };
    await emitAlert([sink], payload, env);
    await emitAlert([sink], payload, env);
    const warnings = errors.mock.calls.filter((c) => String(c[0]).includes("TEST_TG_CHAT_A"));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain("telegram sink skipped");
    expect(String(warnings[0]?.[0])).not.toContain("super-secret-token-value");
  });
});

describe("ndjson sink", () => {
  it("creates the parent directory and appends one parseable line per alert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edge-stats-sink-"));
    const path = join(dir, "deep", "nested", "alerts.ndjson");
    try {
      await emitAlert([{ type: "ndjson", path }], payload, {});
      await emitAlert([{ type: "ndjson", path }], payload, {});
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const parsed = JSON.parse(line) as AlertPayload;
        expect(parsed.v).toBe(1);
        expect(parsed.n).toBe(7);
        expect(parsed.ci95).toEqual([0.25, 0.8419]);
        expect(parsed.disclaimer).toContain("Not predictions");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("desktop sink", () => {
  it("is best-effort: never throws, even with no notification tool installed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(emitAlert([{ type: "desktop" }], payload, {})).resolves.toBeUndefined();
  });
});
