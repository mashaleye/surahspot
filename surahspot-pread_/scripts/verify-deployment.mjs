#!/usr/bin/env node
/**
 * Pre-flight check for a deployment's configuration.
 *
 * Every check here corresponds to a failure that is either silent or that only
 * appears under production conditions: a hint limit that resets because the
 * store is process-local, an Arabic font blocked by the app's own CSP, a
 * fixture upstream left enabled. None of these break `npm run dev`, which is
 * exactly why they need a separate gate.
 *
 * Run against the environment the app will actually use:
 *   node --env-file=.env.production scripts/verify-deployment.mjs
 *
 * Exits non-zero on any error, so it can sit in a release pipeline.
 */

import { statSync } from "node:fs";

const errors = [];
const warnings = [];
const notes = [];

const value = (name) => process.env[name]?.trim() || "";
const truthy = (name) => /^(1|true|yes|on)$/i.test(value(name));

// --- Credentials -----------------------------------------------------------

if (!value("QF_CLIENT_ID") || !value("QF_CLIENT_SECRET")) {
  errors.push("QF_CLIENT_ID and QF_CLIENT_SECRET must both be set.");
}

const qfEnv = value("QF_ENV").toLowerCase();
if (!qfEnv) {
  warnings.push('QF_ENV is unset and will default to "prelive".');
} else if (qfEnv !== "prelive" && qfEnv !== "production") {
  errors.push(`QF_ENV must be "prelive" or "production" (found "${value("QF_ENV")}").`);
} else if (qfEnv === "prelive") {
  warnings.push(
    "QF_ENV=prelive. Pre-live serves a reduced Surah catalog, so rounds will repeat within an attempt.",
  );
}

// --- Round token -----------------------------------------------------------

const secret = value("ROUND_TOKEN_SECRET");
if (!secret) {
  errors.push("ROUND_TOKEN_SECRET is required. Generate one with: openssl rand -hex 32");
} else if (secret.length < 32) {
  errors.push(`ROUND_TOKEN_SECRET is ${secret.length} characters; at least 32 are required.`);
} else if (new Set(secret).size < 8) {
  // "aaaa...aaaa" passes a length check and is worthless.
  errors.push("ROUND_TOKEN_SECRET has very low character variety. Generate a random one.");
}

// --- Fixture upstream ------------------------------------------------------

if (truthy("QF_MOCK")) {
  errors.push(
    "QF_MOCK is enabled. This serves fixture Quran data and must never be set in a deployment.",
  );
}

// --- Shared state ----------------------------------------------------------

const storeUrl = value("ATTEMPT_STORE_URL");
const allowSingleInstance = truthy("ALLOW_SINGLE_INSTANCE_STORE");

if (!storeUrl && !allowSingleInstance) {
  errors.push(
    "No shared attempt store is configured. Set ATTEMPT_STORE_URL to a Redis or Valkey URL. " +
      "The in-memory store enforces the two-hint limit, the round-replay guard and the " +
      "seven-round ceiling only within one process, and on a second replica those rules stop " +
      "holding silently. If this really is a single long-lived process, set " +
      "ALLOW_SINGLE_INSTANCE_STORE=1 to say so deliberately.",
  );
} else if (!storeUrl) {
  warnings.push(
    "Running on the in-memory store with ALLOW_SINGLE_INSTANCE_STORE=1. Correct for exactly one " +
      "long-lived process; add ATTEMPT_STORE_URL before scaling past one replica.",
  );
} else {
  try {
    const parsed = new URL(storeUrl);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      errors.push(`ATTEMPT_STORE_URL must use redis:// or rediss:// (found "${parsed.protocol}").`);
    } else if (parsed.protocol === "redis:" && !/^(localhost|127\.|::1)/.test(parsed.hostname)) {
      warnings.push(
        "ATTEMPT_STORE_URL uses unencrypted redis:// to a remote host. Prefer rediss:// so attempt " +
          "ids do not cross the network in the clear.",
      );
    }
  } catch {
    errors.push("ATTEMPT_STORE_URL is not a valid URL.");
  }
}

// --- Abuse protection ------------------------------------------------------

if (value("RATE_LIMIT_ENABLED").toLowerCase() === "false") {
  warnings.push(
    "RATE_LIMIT_ENABLED=false. One round request fans out to several Quran Foundation calls, so " +
      "an unthrottled loop can exhaust the app's upstream quota for everyone.",
  );
}

// --- Font ------------------------------------------------------------------

// The Quranic face is self-hosted and the CSP allows no cross-origin fallback,
// so a missing file means Arabic renders in a system font with no error
// anywhere. `npm run build` already refuses without it; this catches an image
// or artifact assembled by some other route.
{
  const fontPath = new URL("../public/fonts/UthmanicHafs1Ver18.ttf", import.meta.url);
  try {
    const { size } = statSync(fontPath);
    if (size < 200_000) {
      errors.push(`Quranic font is only ${size} bytes — the download looks truncated.`);
    } else {
      notes.push(`Quranic font is self-hosted (${(size / 1024).toFixed(0)} KB); CSP font-src is 'self'.`);
    }
  } catch {
    errors.push(
      "public/fonts/UthmanicHafs1Ver18.ttf is missing. The app self-hosts this face and the CSP " +
        "permits no cross-origin fallback, so the Arabic would render in a system font. " +
        "Run: npm run fetch:font",
    );
  }
}

// --- Audio allowlist -------------------------------------------------------

if (!value("AUDIO_HOST_ALLOWLIST")) {
  notes.push(
    "AUDIO_HOST_ALLOWLIST is unset, so the proxy accepts any public https host from a sealed " +
      "token. Pinning the CDN narrows this further.",
  );
}

// --- Report ----------------------------------------------------------------

const label = { error: "ERROR", warn: " WARN", note: " NOTE" };

console.log("\nSurahSpot deployment check\n");

for (const message of errors) console.log(`${label.error}  ${message}`);
for (const message of warnings) console.log(`${label.warn}  ${message}`);
for (const message of notes) console.log(`${label.note}  ${message}`);

console.log(
  `\n${errors.length} error(s), ${warnings.length} warning(s).\n` +
    (errors.length
      ? "Deployment is not safe to proceed.\n"
      : "Configuration looks deployable. Verify upstream reachability with:\n" +
        "  curl -sS https://YOUR_HOST/api/health?deep=1\n"),
);

process.exit(errors.length ? 1 : 0);
