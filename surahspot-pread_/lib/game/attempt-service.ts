import "server-only";

import crypto from "node:crypto";
import { getStore } from "@/lib/store";
import { isProduction } from "@/lib/config/env";
import {
  ATTEMPT_TTL_MS,
  type AttemptRecord,
  newAttemptRecord,
  reviveAttemptRecord,
} from "./attempt";

/**
 * Persistence and locking for attempt records.
 *
 * This is the only module that knows attempts are stored anywhere. The pure
 * transitions live in attempt.ts and the backend lives behind KeyValueStore, so
 * this file is just the seam between them.
 */

export const ATTEMPT_COOKIE_NAME = "surahspot_attempt";

function storeKey(attemptId: string) {
  return `attempt:${attemptId}`;
}

function newAttemptId() {
  return crypto.randomBytes(24).toString("base64url");
}

export function newRoundId() {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * Reject anything that could not have come from newAttemptId before it reaches
 * the store. A cookie value is attacker-controlled, and passing it through
 * unchecked would let a crafted value shape the Redis key.
 */
export function isPlausibleAttemptId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

export async function loadAttempt(attemptId: string | null | undefined): Promise<AttemptRecord | null> {
  if (!isPlausibleAttemptId(attemptId)) return null;
  const raw = await getStore().get<unknown>(storeKey(attemptId));
  const record = reviveAttemptRecord(raw);
  if (!record) return null;
  // Touch the TTL so an attempt in progress does not expire mid-attempt.
  await saveAttempt(record);
  return record;
}

export async function saveAttempt(attempt: AttemptRecord): Promise<void> {
  await getStore().set(storeKey(attempt.id), attempt, ATTEMPT_TTL_MS);
}

export async function createAttempt(): Promise<AttemptRecord> {
  const attempt = newAttemptRecord(newAttemptId());
  await saveAttempt(attempt);
  return attempt;
}

export async function loadOrCreateAttempt(attemptId: string | null | undefined): Promise<AttemptRecord> {
  return (await loadAttempt(attemptId)) ?? (await createAttempt());
}

/**
 * Run a mutation with exclusive access to one attempt, then persist it.
 *
 * Every state-changing endpoint goes through here. The record is re-read inside
 * the lock rather than reusing one fetched earlier, because between an earlier
 * read and the lock another request may have spent the last hint or finished
 * the round — which is exactly the race the hint anti-cheat rules exist to stop.
 *
 * The record is written only when the mutation succeeds. A rejected mutation
 * (stale revision, hint allowance exhausted) leaves stored state untouched, so
 * a failed request can never consume an allowance.
 */
export async function mutateAttempt<T>(
  attemptId: string,
  mutate: (attempt: AttemptRecord) => Promise<T> | T,
): Promise<T> {
  const store = getStore();
  return store.withLock(storeKey(attemptId), async () => {
    const raw = await store.get<unknown>(storeKey(attemptId));
    const attempt = reviveAttemptRecord(raw);
    if (!attempt) {
      throw new AttemptSessionError("This attempt session expired. Reload SurahSpot to start again.");
    }
    const result = await mutate(attempt);
    await saveAttempt(attempt);
    return result;
  });
}

export class AttemptSessionError extends Error {
  /** Read structurally by the HTTP layer, which maps it to 409. */
  readonly kind = "conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "AttemptSessionError";
  }
}

export function attemptCookieOptions() {
  return {
    httpOnly: true,
    // Strict is right for a single-origin game with no inbound links into a
    // live round, and it means a cross-site request cannot spend a hint.
    sameSite: "strict" as const,
    // Must stay false over plain-HTTP LAN testing from a phone, or the cookie
    // is never stored and every hint request looks like a new attempt.
    secure: isProduction(),
    path: "/",
    maxAge: ATTEMPT_TTL_MS / 1000,
  };
}
