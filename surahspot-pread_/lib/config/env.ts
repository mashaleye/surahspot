/**
 * Single place where process.env is read and validated.
 *
 * Everything else in the app imports typed getters from here rather than
 * touching process.env directly. That keeps environment handling swappable:
 * adding a new deployment target, a new store backend, or a new feature flag
 * is a change in this file plus one consumer, not a grep across the codebase.
 *
 * Getters are lazy and re-read on every call. Next.js evaluates route modules
 * once per process but tests mutate process.env between cases, so caching the
 * parsed values at module scope would make configuration untestable.
 */

export type QfEnvironment = "prelive" | "production";

export type RuntimeMode = "development" | "test" | "production";

function raw(name: string) {
  return process.env[name]?.trim() || undefined;
}

function bool(name: string, fallback = false) {
  const value = raw(name)?.toLowerCase();
  if (value === undefined) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function int(name: string, fallback: number) {
  const value = Number(raw(name));
  return Number.isFinite(value) ? value : fallback;
}

export function runtimeMode(): RuntimeMode {
  const value = process.env.NODE_ENV;
  if (value === "production" || value === "test") return value;
  return "development";
}

export function isProduction() {
  return runtimeMode() === "production";
}

/**
 * When true, the Quran Foundation client is replaced by an in-process fixture
 * server. This exists so the e2e suite, CI, and offline development can run a
 * complete seven-round attempt without real credentials or network access.
 *
 * NODE_ENV=production means "production build", not "production deployment",
 * and a production build is exactly what the e2e suite should test against —
 * `next start` sets NODE_ENV=production, so refusing outright made the fixture
 * upstream unusable with the very build it was meant to exercise.
 *
 * The deploy protection is kept by requiring a second, deliberate key.
 * QF_MOCK plus QF_MOCK_ACK_PRODUCTION_BUILD together is not a combination
 * anyone sets by accident, whereas QF_MOCK alone is easy to leave behind.
 */
export function mockUpstreamEnabled() {
  const requested = bool("QF_MOCK");
  if (requested && isProduction() && !bool("QF_MOCK_ACK_PRODUCTION_BUILD")) {
    throw new Error(
      "QF_MOCK is enabled in a production build. This serves fixture Quran data and must never " +
        "reach players. If this is a test harness running `next start`, set " +
        "QF_MOCK_ACK_PRODUCTION_BUILD=1 to acknowledge that.",
    );
  }
  return requested;
}

export function qfEnvironment(): QfEnvironment {
  const value = (process.env.QF_ENV ?? "").trim().toLowerCase();
  // An unrecognised value used to fall through to prelive silently, which sends
  // production credentials to the prelive authorization server and comes back
  // as an opaque invalid_client 401. Fail loudly instead.
  if (value && value !== "production" && value !== "prelive") {
    throw new Error(`QF_ENV must be "prelive" or "production" (received "${process.env.QF_ENV}").`);
  }
  return value === "production" ? "production" : "prelive";
}

export function qfCredentials() {
  // Trailing whitespace or a stray newline in .env.local would otherwise be
  // folded into the Basic auth header and rejected as invalid_client.
  const clientId = raw("QF_CLIENT_ID");
  const clientSecret = raw("QF_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing QF_CLIENT_ID or QF_CLIENT_SECRET. Copy .env.example to .env.local and add Quran Foundation credentials.",
    );
  }
  return { clientId, clientSecret };
}

export function roundTokenSecret() {
  const secret = raw("ROUND_TOKEN_SECRET");
  if (!secret) throw new Error("Missing ROUND_TOKEN_SECRET. Add a long random value to .env.local.");
  // Round tokens carry the answer, so a guessable secret would let a player
  // forge or read them. 32 chars is the documented minimum for this app.
  if (secret.length < 32) {
    throw new Error(
      `ROUND_TOKEN_SECRET is too short (${secret.length} chars, need at least 32). Generate one with: openssl rand -hex 32`,
    );
  }
  return secret;
}

/** Redis/Valkey connection string. Absent means the in-memory store is used. */
export function attemptStoreUrl() {
  return raw("ATTEMPT_STORE_URL");
}

/**
 * Explicit acknowledgement that this deployment is one long-lived process.
 *
 * Required in production when ATTEMPT_STORE_URL is unset, because the
 * in-memory store cannot enforce the hint allowance or the replay guard across
 * replicas and does so silently. Making the operator state it converts an
 * invisible correctness failure into a visible configuration choice.
 */
export function allowSingleInstanceStore() {
  return bool("ALLOW_SINGLE_INSTANCE_STORE", false);
}

export function timeouts() {
  return {
    // Applies to the QF request/response headers, not to a streamed body.
    upstreamMs: int("QF_TIMEOUT_MS", 12_000),
    // Audio only needs a header deadline; the body may legitimately stream for
    // an hour on a long chapter.
    audioHeaderMs: int("AUDIO_HEADER_TIMEOUT_MS", 15_000),
  };
}

export function rateLimits() {
  return {
    enabled: bool("RATE_LIMIT_ENABLED", isProduction()),
    // Per client, per window. Rounds are the expensive call (several upstream
    // requests each), so they get the tightest budget.
    roundPerMinute: int("RATE_LIMIT_ROUND_PER_MINUTE", 20),
    searchPerMinute: int("RATE_LIMIT_SEARCH_PER_MINUTE", 90),
    actionPerMinute: int("RATE_LIMIT_ACTION_PER_MINUTE", 120),
  };
}

/**
 * Extra hosts the audio proxy may fetch from, comma separated.
 *
 * The proxy already refuses anything that is not https and not publicly
 * routable. An explicit allowlist narrows it further for deployments that want
 * to pin the CDN. Empty means "any public https host", which is the historical
 * behaviour and is safe because the URL arrives inside a sealed token.
 */
export function audioHostAllowlist() {
  const value = raw("AUDIO_HOST_ALLOWLIST");
  if (!value) return null;
  const hosts = value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length ? hosts : null;
}