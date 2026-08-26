/*
  Dependency license gate. Runs `pnpm licenses list --json` over the whole
  lockfile and fails the build if any dependency carries a license outside
  the allowlist. Copyleft and source-available licenses (GPL/AGPL/LGPL,
  SSPL, BUSL, Commons-Clause) and unknown licenses are never waved through
  here: replace the dependency or take the finding to a maintainer.

  Run with:  pnpm run check:licenses
*/
import { execSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "ISC",
  "MPL-2.0",
  "CC0-1.0",
  "Unlicense",
]);

// Reviewed one-offs, each with the reason it is acceptable. Additions to
// this list are a licensing decision and belong to LuxAlgo review (see
// .github/CODEOWNERS), not to a passing build.
const REVIEWED_EXCEPTIONS = new Map([["BlueOak-1.0.0", "permissive MIT-equivalent (minimatch)"]]);

const raw = execSync("pnpm licenses list --json", {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const byLicense = JSON.parse(raw);

let bad = 0;
for (const [license, packages] of Object.entries(byLicense)) {
  const names = [...new Set(packages.map((p) => p.name))].sort();
  if (ALLOWED.has(license)) {
    console.log(`ok        ${license}: ${names.length} package(s)`);
  } else if (REVIEWED_EXCEPTIONS.has(license)) {
    console.log(`reviewed  ${license}: ${names.join(", ")} (${REVIEWED_EXCEPTIONS.get(license)})`);
  } else {
    bad += 1;
    console.error(`BLOCKED   ${license}: ${names.join(", ")}`);
  }
}

if (bad > 0) {
  console.error(
    `\n${bad} license group(s) outside the allowlist. Replace the dependency ` +
      "or take it to LuxAlgo review; do not extend the allowlist to make CI pass.",
  );
  process.exit(1);
}
console.log("\nall dependency licenses within the allowlist");
