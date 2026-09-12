import { allowSingleInstanceStore, attemptStoreUrl, isProduction } from "@/lib/config/env";
import { MemoryStore } from "./memory-store";
import { RedisStore } from "./redis-store";
import type { KeyValueStore } from "./types";

export type { KeyValueStore } from "./types";
export { MemoryStore } from "./memory-store";
export { RedisStore } from "./redis-store";

type StoreGlobals = typeof globalThis & { __surahspotStore?: KeyValueStore };

/**
 * Resolve the configured store, once per process.
 *
 * Selection is by configuration, not by import: no route handler references
 * MemoryStore or RedisStore directly, so adding a third backend later means
 * adding a file and one branch here.
 *
 * Production without a shared store is refused rather than warned about. The
 * hint allowance, the round-revision replay guard and the seven-round ceiling
 * are only enforceable if every request for an attempt sees the same state —
 * so on a second replica they simply stop working, and they stop working
 * silently. Nothing errors, no metric moves; players just quietly get extra
 * hints. A misconfiguration whose only symptom is "the rules no longer apply"
 * has to fail loudly at the point of configuration.
 *
 * Single-instance deployments are legitimate and opt in with
 * ALLOW_SINGLE_INSTANCE_STORE=1, which is deliberately an explicit statement
 * rather than a default.
 */
export function getStore(): KeyValueStore {
  const globals = globalThis as StoreGlobals;
  if (globals.__surahspotStore) return globals.__surahspotStore;

  const url = attemptStoreUrl();

  if (!url && isProduction() && !allowSingleInstanceStore()) {
    throw new Error(
      "No shared attempt store is configured. Set ATTEMPT_STORE_URL to a Redis or Valkey URL. " +
        "The in-memory store only enforces the two-hint limit, the round-replay guard and the " +
        "seven-round ceiling within a single process, so on more than one replica those rules " +
        "stop holding. If this deployment really is a single long-lived process, set " +
        "ALLOW_SINGLE_INSTANCE_STORE=1 to acknowledge that.",
    );
  }

  const store: KeyValueStore = url ? new RedisStore(url) : new MemoryStore();
  globals.__surahspotStore = store;
  return store;
}

/** Test seam: swap the active store, or reset to the configured default. */
export function setStore(store: KeyValueStore | null) {
  const globals = globalThis as StoreGlobals;
  if (store) globals.__surahspotStore = store;
  else delete globals.__surahspotStore;
}
