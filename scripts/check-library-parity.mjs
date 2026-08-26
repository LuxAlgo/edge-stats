/* global fetch, AbortSignal */
/*
  Library citation parity check.

  The registry (packages/core/src/registry/{fields,predicates,outcomes}.ts)
  and the presets (presets/*.json "library" arrays) cite Library pages as
  { kind: "concept" | "indicator", slug } →
  https://www.luxalgo.com/library/<kind>/<slug>/. This script keeps those
  citations honest over time:

  - every cited page must still exist: HTTP 404 is a rotted citation and a
    hard failure (exit 1) listing the citing files;
  - concept definitions are fetched as markdown
    (…/library/concept/<slug>.md) and their sha256 is compared against
    data/library-parity.lock.json — a mismatch means the Library's
    definition text changed since a human last read it, so a human must
    re-read the page and confirm the engine's definition still agrees
    (exit 2), then accept the new text with --update;
  - --update rewrites the lock file (sorted keys, stable JSON). A citation
    whose page cannot be verified at update time (offline or
    egress-restricted environments) is recorded as
    { "status": "unverified" } instead of a hash; the checker treats such
    entries as skip-with-warning while the page stays unreachable, and
    nags for a real --update baseline once it is reachable again. Verified
    indicators are NOT stored — they carry no text baseline and are
    existence-checked live on every run.

  Polite by construction: sequential fetches, 300 ms apart, 15 s timeout,
  HEAD before GET for indicator pages. Node built-ins only — no installs.

  Run with:  pnpm run check:library-parity
        (or: node scripts/check-library-parity.mjs [--update])

  LIBRARY_PARITY_BASE_URL overrides the site root — a test seam only;
  leave it unset everywhere real.
*/
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.LIBRARY_PARITY_BASE_URL ?? "https://www.luxalgo.com").replace(
  /\/+$/,
  "",
);
const LOCK_PATH = join(repoRoot, "data", "library-parity.lock.json");
const REGISTRY_FILES = [
  "packages/core/src/registry/fields.ts",
  "packages/core/src/registry/predicates.ts",
  "packages/core/src/registry/outcomes.ts",
];
const PRESETS_DIR = "presets";
const FETCH_TIMEOUT_MS = 15_000;
const SPACING_MS = 300;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// Tolerant of quote style, whitespace/newlines, and a trailing comma.
const CITATION_RE =
  /\{\s*kind\s*:\s*["'](concept|indicator)["']\s*,\s*slug\s*:\s*["']([^"'\s]+)["']\s*,?\s*\}/g;
const LOCK_COMMENT =
  "Human-accepted baselines for Library citations. concept/<slug> entries pin the sha256 of the public markdown definition (/library/concept/<slug>.md); a { status: 'unverified' } entry marks a citation the last --update run could not reach and is skipped with a warning until a networked --update blesses it. Verified indicators are existence-checked live and never stored. Managed by scripts/check-library-parity.mjs — update with: node scripts/check-library-parity.mjs --update";

const update = process.argv.slice(2).some((arg) => arg === "--update");
const unknown = process.argv.slice(2).filter((arg) => arg !== "--update");
if (unknown.length > 0) {
  console.error(
    `unknown argument(s): ${unknown.join(", ")} (usage: check-library-parity.mjs [--update])`,
  );
  process.exit(1);
}

function citationUrl(kind, slug) {
  return kind === "concept"
    ? `${BASE_URL}/library/concept/${slug}.md`
    : `${BASE_URL}/library/indicator/${slug}/`;
}

/** Collect every unique { kind, slug } citation and the files citing it. */
function collectCitations() {
  const byKey = new Map();
  const problems = [];
  const add = (kind, slug, file) => {
    if (!SLUG_RE.test(slug)) {
      problems.push(`${file}: suspicious library slug '${slug}' (expected lowercase kebab-case)`);
      return;
    }
    const key = `${kind}/${slug}`;
    if (!byKey.has(key)) byKey.set(key, { kind, slug, citedBy: new Set() });
    byKey.get(key).citedBy.add(file);
  };

  for (const file of REGISTRY_FILES) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    for (const match of source.matchAll(CITATION_RE)) add(match[1], match[2], file);
  }

  const presetFiles = readdirSync(join(repoRoot, PRESETS_DIR))
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of presetFiles) {
    const file = `${PRESETS_DIR}/${name}`;
    const preset = JSON.parse(readFileSync(join(repoRoot, file), "utf8"));
    if (preset.library === undefined) continue;
    if (!Array.isArray(preset.library)) {
      problems.push(`${file}: "library" must be an array of { kind, slug }`);
      continue;
    }
    for (const ref of preset.library) {
      if (
        ref === null ||
        typeof ref !== "object" ||
        (ref.kind !== "concept" && ref.kind !== "indicator") ||
        typeof ref.slug !== "string"
      ) {
        problems.push(`${file}: unrecognized library entry ${JSON.stringify(ref)}`);
        continue;
      }
      add(ref.kind, ref.slug, file);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`BAD CITATION: ${problem}`);
    process.exit(1);
  }
  return [...byKey.values()].sort((a, b) => {
    const ka = `${a.kind}/${a.slug}`;
    const kb = `${b.kind}/${b.slug}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function readLock() {
  if (!existsSync(LOCK_PATH)) return {};
  const raw = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  delete raw["//"];
  return raw;
}

function writeLock(entries) {
  const out = { "//": LOCK_COMMENT };
  for (const key of Object.keys(entries).sort()) out[key] = entries[key];
  writeFileSync(LOCK_PATH, JSON.stringify(out, null, 2) + "\n");
}

let requestCount = 0;
async function request(url, method) {
  if (requestCount > 0) await delay(SPACING_MS); // be polite: 300 ms between requests
  requestCount += 1;
  return fetch(url, {
    method,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "edge-stats-library-parity-check (node)" },
  });
}

/**
 * Fetch one citation. Returns
 *   { outcome: "ok", status, sha256? }   — page exists (sha256 for concepts)
 *   { outcome: "rot", status }           — HTTP 404/410: the citation rotted
 *   { outcome: "unverifiable", detail }  — anything that proves nothing either
 *                                          way (network failure, timeout, or a
 *                                          non-404 error status such as 403/5xx)
 */
async function probe(citation) {
  const url = citationUrl(citation.kind, citation.slug);
  let res;
  try {
    res = await request(url, citation.kind === "concept" ? "GET" : "HEAD");
    // Some hosts refuse HEAD; retry indicator pages as GET before judging.
    if (citation.kind === "indicator" && !res.ok && [403, 405, 501].includes(res.status)) {
      res = await request(url, "GET");
    }
  } catch (err) {
    const cause =
      err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return {
      outcome: "unverifiable",
      detail: `${err instanceof Error ? err.message : String(err)}${cause}`,
    };
  }
  if (res.status === 404 || res.status === 410) {
    if (res.body !== null) await res.body.cancel();
    return { outcome: "rot", status: res.status };
  }
  if (!res.ok) {
    if (res.body !== null) await res.body.cancel();
    return { outcome: "unverifiable", detail: `HTTP ${res.status}` };
  }
  if (citation.kind !== "concept") {
    if (res.body !== null) await res.body.cancel();
    return { outcome: "ok", status: res.status };
  }
  const body = new Uint8Array(await res.arrayBuffer());
  return {
    outcome: "ok",
    status: res.status,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

const citations = collectCitations();
const lock = readLock();
console.log(
  `${citations.length} unique Library citation(s) collected from ${REGISTRY_FILES.length} registry files + ${PRESETS_DIR}/*.json; checking against ${BASE_URL}\n`,
);

const rotted = []; // exit 1: cited pages that no longer exist
const failures = []; // exit 1: could not verify a citation that has a real baseline
const drifted = []; // exit 2: definition text changed vs the accepted baseline
const unblessed = []; // exit 2: cited but never accepted into the lock
const warnings = []; // exit 0: skipped or advisory
const nextLock = {}; // --update only

for (const citation of citations) {
  const key = `${citation.kind}/${citation.slug}`;
  const url = citationUrl(citation.kind, citation.slug);
  const citedBy = [...citation.citedBy].sort().join(", ");
  const entry = lock[key];
  const result = await probe(citation);

  if (result.outcome === "rot") {
    rotted.push(`${key} — HTTP ${result.status} at ${url}\n    cited by: ${citedBy}`);
    console.log(`ROT         ${key} (HTTP ${result.status})`);
    continue;
  }

  if (result.outcome === "unverifiable") {
    if (update) {
      nextLock[key] = { status: "unverified" };
      warnings.push(`${key}: could not verify (${result.detail}) — recorded as unverified`);
      console.log(`UNVERIFIED  ${key} (${result.detail})`);
    } else if (entry?.status === "unverified") {
      warnings.push(
        `${key}: unverified in the lock and still unreachable (${result.detail}) — skipped; run --update from a machine that can reach ${BASE_URL} to bless a baseline`,
      );
      console.log(`SKIP        ${key} (unverified in lock; ${result.detail})`);
    } else {
      failures.push(
        `${key}: could not verify (${result.detail}) at ${url}\n    cited by: ${citedBy}`,
      );
      console.log(`FAIL        ${key} (${result.detail})`);
    }
    continue;
  }

  // outcome: "ok"
  if (citation.kind !== "concept") {
    if (entry?.status === "unverified") {
      warnings.push(
        `${key}: reachable again — the stale 'unverified' lock entry clears on the next --update`,
      );
    }
    console.log(`ok          ${key}`);
    continue;
  }

  if (update) {
    nextLock[key] = { sha256: result.sha256 };
    const note =
      entry?.sha256 === undefined
        ? ""
        : entry.sha256 === result.sha256
          ? " (unchanged)"
          : " (changed — accepting new text)";
    console.log(`LOCKED      ${key} sha256:${result.sha256.slice(0, 12)}…${note}`);
    continue;
  }

  if (entry?.sha256 === result.sha256) {
    console.log(`ok          ${key} sha256:${result.sha256.slice(0, 12)}…`);
  } else if (entry?.sha256 !== undefined) {
    drifted.push(`${key} — ${url}\n    cited by: ${citedBy}`);
    console.log(
      `DRIFT       ${key} (lock ${entry.sha256.slice(0, 12)}… vs live ${result.sha256.slice(0, 12)}…)`,
    );
  } else if (entry?.status === "unverified") {
    warnings.push(
      `${key}: page verified reachable, but the lock holds no accepted hash — re-read ${url} and run --update to bless it`,
    );
    console.log(`UNBLESSED   ${key} (reachable; no accepted hash in lock)`);
  } else {
    unblessed.push(`${key} — ${url}\n    cited by: ${citedBy}`);
    console.log(`NEW         ${key} (not in lock)`);
  }
}

console.log("");
for (const warning of warnings) console.warn(`WARNING: ${warning}`);

if (update) {
  if (rotted.length > 0) {
    console.error(
      `\n${rotted.length} rotted citation(s) — fix the citations first; lock NOT rewritten:`,
    );
    for (const line of rotted) console.error(`  ${line}`);
    process.exit(1);
  }
  const stale = Object.keys(lock).filter(
    (key) => !citations.some((c) => `${c.kind}/${c.slug}` === key),
  );
  writeLock(nextLock);
  const hashes = Object.values(nextLock).filter((e) => e.sha256 !== undefined).length;
  const unverified = Object.keys(nextLock).length - hashes;
  console.log(
    `\nlock rewritten: ${Object.keys(nextLock).length} entries (${hashes} concept hash(es), ${unverified} unverified)` +
      (stale.length > 0 ? `; dropped ${stale.length} no-longer-cited: ${stale.join(", ")}` : ""),
  );
  if (unverified > 0) {
    console.log(
      "unverified entries mean this environment could not reach the Library — re-run --update from a networked machine to record real baselines.",
    );
  }
  process.exit(0);
}

if (rotted.length > 0 || failures.length > 0) {
  if (rotted.length > 0) {
    console.error(
      `\n${rotted.length} ROTTED citation(s) — the cited Library page no longer exists. Fix or remove the citation in the listed files:`,
    );
    for (const line of rotted) console.error(`  ${line}`);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} citation(s) could not be verified at all:`);
    for (const line of failures) console.error(`  ${line}`);
  }
  process.exit(1);
}

if (drifted.length > 0 || unblessed.length > 0) {
  if (drifted.length > 0) {
    console.error(
      `\n${drifted.length} DRIFTED concept definition(s): the Library's definition text changed since it was last accepted. ` +
        `A human must re-read each page and confirm the engine's definition (the registry doc text) still agrees, ` +
        `then accept with: node scripts/check-library-parity.mjs --update`,
    );
    for (const line of drifted) console.error(`  ${line}`);
  }
  if (unblessed.length > 0) {
    console.error(
      `\n${unblessed.length} citation(s) not in the lock: read the cited definition, confirm the engine agrees, ` +
        `then record a baseline with: node scripts/check-library-parity.mjs --update`,
    );
    for (const line of unblessed) console.error(`  ${line}`);
  }
  process.exit(2);
}

console.log(
  `ok: ${citations.length} citation(s) checked${warnings.length > 0 ? ` (${warnings.length} warning(s) — see above)` : ""}`,
);
