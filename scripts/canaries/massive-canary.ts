/*
  Massive canary: the adapter is flat-file-first and its REST path is a
  documented TODO (no verified endpoint to fingerprint — guessing URLs is
  what canaries exist to prevent). Without a key the job skips; with one
  it reports the TODO so the scheduled run stays green and honest.
  Scheduled; never a PR gate.
*/
if (!process.env.MASSIVE_API_KEY) {
  console.log("skipped: no key configured (set the MASSIVE_API_KEY repo secret to enable)");
  process.exit(0);
}

console.log(
  "nothing to fingerprint yet: the massive adapter imports local flat files; its REST path is a " +
    "documented TODO in packages/core/src/adapters/massive.ts — extend this canary when it lands",
);
process.exit(0);
