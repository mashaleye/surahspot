import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import type { KeyValueStore } from "./types";

/**
 * Redis/Valkey backed store, spoken over RESP directly.
 *
 * Written without ioredis or node-redis on purpose. SurahSpot stores four small
 * JSON blobs and takes a lock; pulling in a full client (and its transitive
 * tree, and its own reconnect semantics) to do that would add more surface than
 * it removes. The wire protocol used here is the documented subset: SET with
 * PX/NX, GET, DEL, EVAL, PING, AUTH, SELECT.
 *
 * Not wired up unless ATTEMPT_STORE_URL is set, so single-instance deployments
 * pay nothing for it.
 */

type Resp = string | number | null | Resp[];

const LOCK_TTL_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 5_000;

/** Release only if we still hold the lock, so a slow request cannot free someone else's. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

function encodeCommand(args: Array<string | number>) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const value = String(arg);
    out += `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }
  return Buffer.from(out, "utf8");
}

/**
 * Incremental RESP parser. Returns null when the buffer holds a partial reply,
 * which is the normal case on a busy socket: replies do not align with TCP
 * segment boundaries.
 */
function parseReply(buffer: Buffer, offset: number): { value: Resp; next: number } | null {
  if (offset >= buffer.length) return null;
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) return null;

  const type = String.fromCharCode(buffer[offset]);
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const afterLine = lineEnd + 2;

  switch (type) {
    case "+":
      return { value: line, next: afterLine };
    case "-":
      throw new Error(`Redis error: ${line}`);
    case ":":
      return { value: Number(line), next: afterLine };
    case "$": {
      const length = Number(line);
      if (length === -1) return { value: null, next: afterLine };
      const end = afterLine + length;
      if (buffer.length < end + 2) return null;
      return { value: buffer.toString("utf8", afterLine, end), next: end + 2 };
    }
    case "*": {
      const count = Number(line);
      if (count === -1) return { value: null, next: afterLine };
      const items: Resp[] = [];
      let cursor = afterLine;
      for (let i = 0; i < count; i += 1) {
        const item = parseReply(buffer, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`Unsupported RESP type "${type}".`);
  }
}

type Pending = { resolve: (value: Resp) => void; reject: (error: Error) => void };

class RedisConnection {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending: Pending[] = [];

  constructor(private readonly url: URL) {}

  private async connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const secure = this.url.protocol === "rediss:";
      const port = Number(this.url.port || 6379);
      const host = this.url.hostname;

      const socket = secure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });

      const onError = (error: Error) => {
        this.teardown(error);
        reject(error);
      };

      socket.once("error", onError);
      socket.once(secure ? "secureConnect" : "connect", () => {
        socket.off("error", onError);
        socket.on("error", (error) => this.teardown(error));
        socket.on("close", () => this.teardown(new Error("Redis connection closed.")));
        socket.on("data", (chunk) => this.onData(chunk));
        socket.setNoDelay(true);
        this.socket = socket;
        resolve(socket);
      });
    })
      .then(async (socket) => {
        const username = decodeURIComponent(this.url.username || "");
        const password = decodeURIComponent(this.url.password || "");
        if (password) {
          await this.send(username ? ["AUTH", username, password] : ["AUTH", password]);
        }
        const db = this.url.pathname.replace("/", "");
        if (db && db !== "0") await this.send(["SELECT", db]);
        return socket;
      })
      .finally(() => { this.connecting = null; });

    return this.connecting;
  }

  private teardown(error: Error) {
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    socket?.destroy();
    while (this.pending.length) this.pending.shift()!.reject(error);
  }

  private onData(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      let reply: { value: Resp; next: number } | null;
      try {
        reply = parseReply(this.buffer, 0);
      } catch (error) {
        // A protocol-level error reply belongs to the oldest in-flight command.
        this.buffer = Buffer.alloc(0);
        this.pending.shift()?.reject(error as Error);
        continue;
      }
      if (!reply) return;
      this.buffer = Buffer.from(this.buffer.subarray(reply.next));
      this.pending.shift()?.resolve(reply.value);
    }
  }

  /** Send without ensuring a connection — used during the handshake itself. */
  private send(args: Array<string | number>): Promise<Resp> {
    return new Promise<Resp>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.destroyed) {
        reject(new Error("Redis socket is not open."));
        return;
      }
      this.pending.push({ resolve, reject });
      socket.write(encodeCommand(args), (error) => {
        if (error) {
          const index = this.pending.findIndex((entry) => entry.reject === reject);
          if (index >= 0) this.pending.splice(index, 1);
          reject(error);
        }
      });
    });
  }

  async command(args: Array<string | number>): Promise<Resp> {
    await this.connect();
    return this.send(args);
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}

export class RedisStore implements KeyValueStore {
  readonly name = "redis";
  private readonly connection: RedisConnection;
  private readonly prefix: string;

  constructor(url: string, options: { prefix?: string } = {}) {
    this.connection = new RedisConnection(new URL(url));
    this.prefix = options.prefix ?? "surahspot:";
  }

  private key(key: string) {
    return `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.connection.command(["GET", this.key(key)]);
    if (typeof value !== "string") return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      // A value we cannot parse is a value we did not write. Drop it rather
      // than failing every subsequent request for this attempt.
      await this.delete(key);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.connection.command([
      "SET",
      this.key(key),
      JSON.stringify(value),
      "PX",
      Math.max(1, Math.round(ttlMs)),
    ]);
  }

  async delete(key: string): Promise<void> {
    await this.connection.command(["DEL", this.key(key)]);
  }

  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const lockKey = this.key(`lock:${key}`);
    const owner = crypto.randomBytes(12).toString("base64url");
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;

    for (;;) {
      const acquired = await this.connection.command([
        "SET", lockKey, owner, "NX", "PX", LOCK_TTL_MS,
      ]);
      if (acquired === "OK") break;
      if (Date.now() >= deadline) {
        // Falling through without the lock would let two requests both spend
        // the last hint. Refusing is the safe failure.
        throw new Error("Another action for this attempt is still in progress. Try again.");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }

    try {
      return await fn();
    } finally {
      try {
        await this.connection.command(["EVAL", RELEASE_SCRIPT, 1, lockKey, owner]);
      } catch {
        // The lock expires on its own; a failed release must not mask the
        // result (or the error) of the work we just did.
      }
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.connection.command(["PING"])) === "PONG";
    } catch {
      return false;
    }
  }

  close() {
    this.connection.close();
  }
}
