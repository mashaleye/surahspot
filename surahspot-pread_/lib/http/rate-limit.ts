import type { NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { rateLimited } from "./api-error";

/**
 * Fixed-window rate limiting, on top of the same store as attempt state.
 *
 * SurahSpot has no login, and one `/api/quran/round` call fans out to several
 * Quran Foundation requests. Without a limit, a loop against that endpoint
 * burns the app's upstream quota and takes the game down for real players —
 * so this protects the QF relationship as much as the server.
 *
 * A fixed window is used rather than a sliding log because the bound worth
 * enforcing here is "roughly this many per minute", and a sliding window would
 * cost a list read and write per request for precision nobody will notice.
 */

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Best-effort client identity.
 *
 * The attempt cookie is preferred: it is per-browser and survives a changing
 * mobile IP. IP is the fallback, and is read from forwarded headers because in
 * every target deployment the app sits behind a proxy. Only the first entry of
 * X-Forwarded-For is used — the rest is client-supplied and trivially spoofed.
 */
export function clientKey(request: NextRequest, attemptId?: string | null) {
  return rateLimitIdentities(request, attemptId)[0];
}

/**
 * Every identity a request should be counted against.
 *
 * Both are needed, and using only one is a bypass in each direction. Counting
 * only the attempt cookie means clearing cookies resets the budget — and the
 * round endpoint issues a cookie on its first response, so a naive
 * "attempt if present, else IP" rule silently moves every caller into a fresh
 * bucket after one request and never limits anything. Counting only the IP
 * punishes everyone behind one mobile carrier NAT for one abuser.
 *
 * So a request must satisfy the IP budget and, when it has one, its own
 * attempt budget.
 */
export function rateLimitIdentities(request: NextRequest, attemptId?: string | null) {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip =
    forwarded?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "unknown";

  const identities = [`ip:${ip}`];
  if (attemptId) identities.push(`attempt:${attemptId}`);
  return identities;
}

export async function checkRateLimit(
  bucket: string,
  identity: string,
  limit: number,
  windowMs = 60_000,
): Promise<RateLimitResult> {
  const store = getStore();
  const window = Math.floor(Date.now() / windowMs);
  const key = `ratelimit:${bucket}:${identity}:${window}`;
  const resetAt = (window + 1) * windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));

  try {
    // The read-modify-write runs under the store lock so two concurrent
    // requests cannot both read the same count. Without it the limit is
    // approximate under exactly the burst it is meant to catch.
    return await store.withLock(key, async () => {
      const current = (await store.get<number>(key)) ?? 0;
      if (current >= limit) {
        return { allowed: false, limit, remaining: 0, retryAfterSeconds };
      }
      await store.set(key, current + 1, resetAt - Date.now() + 1_000);
      return { allowed: true, limit, remaining: Math.max(0, limit - current - 1), retryAfterSeconds };
    });
  } catch {
    // A store outage must not take the game offline. Failing open is the right
    // trade here: the limiter is abuse protection, not an access control.
    return { allowed: true, limit, remaining: limit, retryAfterSeconds };
  }
}

/** Throws a 429 AppError when any of the request's buckets is exhausted. */
export async function enforceRateLimit(
  bucket: string,
  identity: string | readonly string[],
  limit: number,
  windowMs = 60_000,
) {
  const identities = typeof identity === "string" ? [identity] : identity;

  for (const value of identities) {
    const result = await checkRateLimit(bucket, value, limit, windowMs);
    if (!result.allowed) {
      throw rateLimited(
        "Too many requests. Give it a moment and try again.",
        result.retryAfterSeconds,
      );
    }
  }
}
