import { beforeEach } from "vitest";

/**
 * Baseline environment for every test file.
 *
 * Set here rather than in a .env file so the suite never depends on a
 * developer's local configuration, and so a missing .env.local cannot make the
 * tests pass for the wrong reason.
 */
// NODE_ENV is typed readonly by @types/node; the cast is the standard way
// to set it for a test process.
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.QF_MOCK = "1";
process.env.QF_ENV = "prelive";
process.env.QF_CLIENT_ID = "test-client-id";
process.env.QF_CLIENT_SECRET = "test-client-secret";
// Exactly 64 hex characters, matching what `openssl rand -hex 32` produces.
process.env.ROUND_TOKEN_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// Rate limiting is off by default so functional assertions are not
// accidentally throttled. The rate-limit tests enable it explicitly.
process.env.RATE_LIMIT_ENABLED = "false";
delete process.env.ATTEMPT_STORE_URL;

beforeEach(() => {
  // Per-process global caches (store, tokens, catalog, timed chapters) would
  // otherwise leak between tests in the same file.
  const globals = globalThis as Record<string, unknown>;
  for (const key of Object.keys(globals)) {
    if (key.startsWith("__surahspot")) delete globals[key];
  }
});
