import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Unit and integration test configuration.
 *
 * Everything here runs in Node, not jsdom. The suite deliberately targets the
 * modules under lib/ — scoring, timing, tokens, attempt state, SSRF checks —
 * because those are where a regression is silent and expensive. Browser
 * behaviour is covered by Playwright against a real build instead of by
 * simulating a DOM, which for an audio-driven game would mostly test the
 * simulation.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // `server-only` is a build-time guard: it resolves to a module that
      // throws unless a bundler has marked the graph as server-side. Vitest is
      // neither, so importing any route handler explodes. Aliasing it to an
      // empty module keeps the guard doing its job in `next build` while
      // letting the tests import the same files the server runs.
      "server-only": new URL("./tests/stubs/server-only.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Store state and token caches hang off globalThis so they survive Next's
    // hot reload. That makes them shared mutable state between test files, so
    // each file gets its own process.
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["lib/**/*.ts"],
      exclude: ["lib/quran/mock-upstream.ts", "lib/quran/languages.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
