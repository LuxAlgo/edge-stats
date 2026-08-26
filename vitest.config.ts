import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // DuckDB opens native handles per store; forked processes keep tests isolated.
    pool: "forks",
  },
});
