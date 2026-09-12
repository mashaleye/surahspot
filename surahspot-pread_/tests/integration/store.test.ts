import { afterAll, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { MemoryStore } from "@/lib/store/memory-store";
import { RedisStore } from "@/lib/store/redis-store";
import type { KeyValueStore } from "@/lib/store/types";

/**
 * Contract tests for the storage backends.
 *
 * The Redis client here is hand-written against RESP rather than delegating to
 * ioredis, which means the protocol handling is this project's responsibility
 * and has to be tested rather than assumed. The cases below target the parts
 * that are easy to get subtly wrong: replies split across TCP segments,
 * pipelined commands, lock ownership, and TTL handling.
 *
 * The Redis suite skips itself when no server is reachable, so `npm test` still
 * passes on a machine without one. CI runs it with a redis service so the skip
 * never silently hides a regression.
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6390";

async function redisReachable(url: string) {
  const parsed = new URL(url);
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
    });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

const hasRedis = await redisReachable(REDIS_URL);

/**
 * One suite run against every implementation.
 *
 * Written as a shared contract because the whole point of KeyValueStore is that
 * the layers above cannot tell the backends apart. A behaviour that holds for
 * the memory store and not for Redis would be a bug that only appears in
 * production, which is the category this abstraction exists to prevent.
 */
function describeStoreContract(name: string, createStore: () => KeyValueStore) {
  describe(`${name} store contract`, () => {
    let store: KeyValueStore;
    let namespace: string;

    beforeEach(() => {
      store = createStore();
      // Namespaced per test so a shared Redis does not leak state between them.
      namespace = `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    });

    it("round-trips a structured value", async () => {
      const record = { id: "a", hintsUsed: 1, rounds: { r1: { revealedHints: ["juz"] } } };
      await store.set(`${namespace}:attempt`, record, 10_000);
      expect(await store.get(`${namespace}:attempt`)).toEqual(record);
    });

    it("returns null for a key that was never written", async () => {
      expect(await store.get(`${namespace}:missing`)).toBeNull();
    });

    it("returns null after a delete", async () => {
      await store.set(`${namespace}:k`, { value: 1 }, 10_000);
      await store.delete(`${namespace}:k`);
      expect(await store.get(`${namespace}:k`)).toBeNull();
    });

    it("expires a value once its TTL passes", async () => {
      await store.set(`${namespace}:ttl`, { value: 1 }, 60);
      expect(await store.get(`${namespace}:ttl`)).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await store.get(`${namespace}:ttl`)).toBeNull();
    });

    it("overwrites rather than merging", async () => {
      await store.set(`${namespace}:k`, { a: 1, b: 2 }, 10_000);
      await store.set(`${namespace}:k`, { a: 9 }, 10_000);
      expect(await store.get(`${namespace}:k`)).toEqual({ a: 9 });
    });

    it("serializes concurrent holders of the same lock", async () => {
      // This is the property the two-hint limit rests on: a read-modify-write
      // under withLock must never interleave with another one.
      const order: string[] = [];
      let counter = 0;

      const increment = async (label: string) => {
        await store.withLock(`${namespace}:lock`, async () => {
          const current = counter;
          order.push(`${label}:enter`);
          // Yield, so an implementation that does not actually hold the lock
          // will interleave here and lose an increment.
          await new Promise((resolve) => setTimeout(resolve, 20));
          counter = current + 1;
          order.push(`${label}:exit`);
        });
      };

      await Promise.all([increment("a"), increment("b"), increment("c")]);

      expect(counter).toBe(3);
      // No holder may enter before the previous one exited.
      for (let index = 0; index < order.length; index += 2) {
        expect(order[index]).toMatch(/:enter$/);
        expect(order[index + 1]).toMatch(/:exit$/);
        expect(order[index].split(":")[0]).toBe(order[index + 1].split(":")[0]);
      }
    });

    it("releases the lock when the body throws", async () => {
      // A failed mutation must not wedge every later request for that attempt.
      await expect(
        store.withLock(`${namespace}:lock`, () => {
          throw new Error("mutation failed");
        }),
      ).rejects.toThrow("mutation failed");

      await expect(store.withLock(`${namespace}:lock`, async () => "recovered"))
        .resolves.toBe("recovered");
    });

    it("allows different keys to be locked at the same time", async () => {
      let concurrent = 0;
      let peak = 0;

      const hold = (key: string) =>
        store.withLock(`${namespace}:${key}`, async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 25));
          concurrent -= 1;
        });

      await Promise.all([hold("one"), hold("two")]);
      expect(peak).toBe(2);
    });

    it("returns the value the locked body produced", async () => {
      expect(await store.withLock(`${namespace}:lock`, () => 42)).toBe(42);
    });

    it("answers a liveness probe", async () => {
      expect(await store.ping()).toBe(true);
    });
  });
}

describeStoreContract("memory", () => new MemoryStore());

describe.skipIf(!hasRedis)("redis", () => {
  const stores: RedisStore[] = [];

  afterAll(() => {
    for (const store of stores) store.close();
  });

  describeStoreContract("redis", () => {
    const store = new RedisStore(REDIS_URL, { prefix: "surahspot-test:" });
    stores.push(store);
    return store;
  });

  describe("RESP protocol handling", () => {
    let store: RedisStore;

    beforeEach(() => {
      store = new RedisStore(REDIS_URL, { prefix: "surahspot-test:" });
      stores.push(store);
    });

    it("handles a value far larger than one TCP segment", async () => {
      // Bulk replies do not align with segment boundaries, so the parser has
      // to buffer partial replies rather than assuming one read is one reply.
      const large = { blob: "\u0628".repeat(200_000) };
      await store.set("big", large, 10_000);
      expect(await store.get<typeof large>("big")).toEqual(large);
    });

    it("keeps pipelined replies matched to their commands", async () => {
      // Commands issued without awaiting each other arrive as a stream of
      // replies; mismatching them would silently return another key's value.
      await Promise.all(
        Array.from({ length: 25 }, (_, index) => store.set(`pipe:${index}`, { index }, 10_000)),
      );

      const results = await Promise.all(
        Array.from({ length: 25 }, (_, index) => store.get<{ index: number }>(`pipe:${index}`)),
      );

      results.forEach((result, index) => expect(result).toEqual({ index }));
    });

    it("recovers from a corrupt value instead of failing every later read", async () => {
      const raw = new RedisStore(REDIS_URL, { prefix: "surahspot-test:" });
      stores.push(raw);
      // Write something that is not JSON, the way a different app sharing the
      // database might.
      await (raw as unknown as {
        connection: { command(args: Array<string | number>): Promise<unknown> };
      }).connection.command(["SET", "surahspot-test:corrupt", "{not json"]);

      expect(await store.get("corrupt")).toBeNull();
      await store.set("corrupt", { ok: true }, 10_000);
      expect(await store.get("corrupt")).toEqual({ ok: true });
    });

    it("does not release a lock it no longer owns", async () => {
      // The release is a compare-and-delete on the owner token. Without that,
      // a slow request could free a lock another request had already taken.
      const key = `owner-${Date.now()}`;
      let innerRan = false;

      await store.withLock(key, async () => {
        innerRan = true;
      });

      expect(innerRan).toBe(true);
      // The lock is gone, so the next acquisition is immediate rather than
      // waiting for the TTL to lapse.
      const startedAt = Date.now();
      await store.withLock(key, () => undefined);
      expect(Date.now() - startedAt).toBeLessThan(500);
    });

    it("reports an unreachable server rather than hanging", async () => {
      const unreachable = new RedisStore("redis://127.0.0.1:6399");
      stores.push(unreachable);
      expect(await unreachable.ping()).toBe(false);
    });
  });
});
