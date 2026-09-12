import type { KeyValueStore } from "./types";

type Entry = { value: unknown; expiresAt: number };

type MemoryGlobals = typeof globalThis & {
  __surahspotMemoryEntries?: Map<string, Entry>;
  __surahspotMemoryLocks?: Map<string, Promise<void>>;
};

/**
 * Process-local store. Correct for `next dev`, `next start` on a single
 * instance, and the test suite. Not correct across replicas — see redis-store.
 *
 * State hangs off globalThis because the Next dev server re-evaluates modules
 * on hot reload, and a fresh Map each time would drop every in-flight attempt.
 */
export class MemoryStore implements KeyValueStore {
  readonly name = "memory";

  private readonly entries: Map<string, Entry>;
  private readonly locks: Map<string, Promise<void>>;
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    const globals = globalThis as MemoryGlobals;
    this.entries = globals.__surahspotMemoryEntries ??= new Map();
    this.locks = globals.__surahspotMemoryLocks ??= new Map();
    // A bound matters because attempt ids are minted per browser with no login.
    // Without it a crawler hitting /api/quran/round in a loop grows the map
    // until the process dies.
    this.maxEntries = options.maxEntries ?? 50_000;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.evictIfNeeded();
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const lockKey = `lock:${key}`;
    const previous = this.locks.get(lockKey) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Chain onto the previous holder even if it rejected, otherwise one failed
    // mutation would wedge every later request for this attempt.
    const tail = previous.then(() => gate, () => gate);
    this.locks.set(lockKey, tail);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(lockKey) === tail) this.locks.delete(lockKey);
    }
  }

  async ping(): Promise<boolean> {
    return true;
  }

  /** Test helper. Not part of the interface. */
  clear() {
    this.entries.clear();
    this.locks.clear();
  }

  private evictIfNeeded() {
    if (this.entries.size < this.maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // Still full after dropping expired entries: shed the oldest insertions.
    // Map preserves insertion order, so this approximates FIFO eviction.
    if (this.entries.size >= this.maxEntries) {
      const excess = this.entries.size - this.maxEntries + 1;
      let removed = 0;
      for (const key of this.entries.keys()) {
        this.entries.delete(key);
        if (++removed >= excess) break;
      }
    }
  }
}
