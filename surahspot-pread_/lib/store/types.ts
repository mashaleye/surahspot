/**
 * Storage contract for everything that must survive between requests.
 *
 * SurahSpot's anti-cheat rules — two hints per attempt, one-shot round
 * revisions, seven rounds per attempt — are only sound if every request for a
 * given attempt observes the same state and mutations are serialized. The
 * original implementation held that in a module-level Map, which is correct on
 * one long-lived Node process and silently wrong on Vercel, Cloud Run, or any
 * multi-replica deployment: a player could land on a fresh instance and get two
 * more hints.
 *
 * This interface is deliberately tiny — get, set, delete, withLock — so a new
 * backend is a single small file. Nothing above this layer knows whether the
 * data lives in a Map or in Redis.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;

  /**
   * Run `fn` with exclusive access to `key`. Implementations must serialize
   * concurrent callers rather than failing fast, because two hint requests
   * arriving together is normal double-tap behaviour, not an error.
   */
  withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T>;

  /** Best-effort liveness probe used by /api/health. */
  ping(): Promise<boolean>;

  /** Human-readable backend name, surfaced in the health endpoint. */
  readonly name: string;
}
