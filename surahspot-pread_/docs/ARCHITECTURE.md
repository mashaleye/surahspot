# Architecture

This document explains how SurahSpot is put together and, more usefully, *why*
each boundary is where it is. The organising constraint is that this codebase is
expected to keep changing — new hint types, different attempt lengths, a timed
mode, a different storage backend — so the goal throughout is that any one of
those changes touches one file rather than five.

## Layers

```
app/api/**/route.ts        transport   parse → authorize → delegate → serialize
        │
        ▼
lib/game/**                domain      rules, attempt state, round assembly
lib/quran/**               domain      catalog, tokens, timing, text
        │
        ▼
lib/store/**               storage     KeyValueStore: memory | redis
lib/net, lib/http          plumbing    SSRF checks, errors, rate limiting
lib/config/env.ts          config      the only module that reads process.env
```

Dependencies point downward only. `lib/game/rules.ts` imports nothing at all —
not Next, not React, not `node:crypto`. That is what makes the scoring rules
testable in isolation and reusable from both the server and the browser.

## Why the domain doesn't know about HTTP

The rules modules throw plain errors carrying a `kind` string:

```ts
throw new AttemptRuleError("This round is no longer active.", "conflict");
```

`lib/http/api-error.ts` reads that `kind` *structurally* — it never imports
`AttemptRuleError`. So the domain can say "this is a 409, not a crash" without
depending on the web framework, and swapping Next for anything else would not
touch a single rule.

The alternative we didn't take was having the domain import `NextResponse`, or
having the HTTP layer regex-match error message text to recover a status code.
The original hint route did the latter:

```ts
const status = /already|used|stale|active|session|expired/i.test(message) ? 409 : 500;
```

That breaks the moment someone rewords a message.

## Why attempt state is a plain object

`AttemptRecord` is ordinary JSON — arrays, not `Set`; a record, not a `Map`.

This is not a style preference. The original used `Set<HintType>` and
`Map<string, RoundState>` inside the state object, and `JSON.stringify(new Set())`
is `{}`. That single detail welded the game rules to in-process storage: the
state physically could not be written to Redis without a rewrite. Making the
record serializable is what allowed `KeyValueStore` to exist at all.

`reviveAttemptRecord` coerces field by field rather than trusting the shape, so
a record written by an older deploy ages out gracefully instead of throwing on
every request until its TTL expires.

## The store boundary

```ts
interface KeyValueStore {
  get / set / delete
  withLock(key, fn)   // serialize, don't fail fast
  ping()
}
```

Four methods, because that is all the app needs. `withLock` must *queue*
concurrent callers rather than reject them — two hint requests arriving together
is a double-tap, not an attack.

Two implementations ship:

- **`MemoryStore`** — correct for `next dev`, `next start` on one instance, and
  the test suite. State hangs off `globalThis` so a dev-server hot reload doesn't
  drop in-flight attempts. Bounded at 50k entries with FIFO eviction, because
  attempt ids are minted per browser with no login and an unbounded map is a
  memory leak waiting for a crawler.
- **`RedisStore`** — speaks RESP directly over a socket. No ioredis, no
  node-redis. The app stores four small JSON blobs and takes a lock; importing a
  full client and its transitive tree to do that adds more surface than it
  removes. Locks use `SET NX PX` with a Lua compare-and-delete release, so a slow
  request cannot free someone else's lock.

`getStore()` picks one from `ATTEMPT_STORE_URL`. No route handler names either
class, so a third backend is a file plus one branch.

## Why this matters for correctness, not just scale

Three rules depend on shared state:

| Rule | Enforced by |
|---|---|
| Two hints per attempt | `attempt.hintsUsed`, behind an HttpOnly cookie |
| No token replay | `round.revision`, rotated on every mutation |
| Seven rounds per attempt | `attempt.roundsCompleted` |

On a single process the in-memory store enforces all three. On two replicas it
enforces none of them reliably — a player who lands on a second instance gets a
fresh hint allowance. That is why `ATTEMPT_STORE_URL` is a correctness setting on
any multi-instance deploy, not a performance one.

## The round token

An AES-256-GCM sealed blob carrying the answer, the audio URL, the scoring state,
and the `attemptId` / `roundId` / `revision` triple.

The revision is the interesting part. Every state-changing action asserts the
current revision and then increments it, so a token saved before a paid hint is
*stale* afterwards and cannot be replayed to dodge the 3-point deduction. The
cookie must also match `attemptId`, so a token lifted from one browser is useless
in another.

Failures are deliberately indistinguishable — bad signature, expired, and
malformed all produce one message. Telling them apart would tell someone probing
the endpoint which part of a forged token they got right.

## Karaoke timing

`normalizeSegments` (server) and `resolveKaraokeState` (client) are two halves of
one contract and now live in one file. Previously they were in the route and the
component respectively, with the "segments must be sorted" invariant documented
on only one side.

State is derived from `audio.currentTime`, never from a frame counter. A dropped
frame or a backgrounded tab causes the highlight to *jump to the right word* on
the next frame rather than drift permanently behind.

## Request flow

```
POST /api/quran/round
  rate limit (ip + attempt)
  load attempt from cookie          ← server-authoritative
  buildRound()                      ← Surah first, then Ayah
  registerRound()                   ← throws on the 8th
  sealRound() → opaque token
  respond { words, audio, progress }  ← no chapterId, no verseKey
```

Surah is drawn **first** and uniformly, then an Ayah within it. Drawing an Ayah
from the whole Quran would make Al-Baqarah ~95× likelier than Al-Kawthar.

## Fixture upstream

`QF_MOCK=1` swaps Quran Foundation for `lib/quran/mock-upstream.ts` before any
network call. It models the awkward cases on purpose: a reciter with no word
segments, a reciter with chapter coverage gaps, and segments returned out of
order. Refused when `NODE_ENV=production`, and `/api/health` reports that refusal
as `degraded` with the reason rather than crashing.

This is what lets CI run a full seven-round attempt on a forked pull request with
no secrets and no upstream quota.

## Extension points

| To change… | Edit |
|---|---|
| Scoring, tries, hint cost, attempt length | `lib/game/rules.ts` |
| A new hint type | `rules.ts` (type) + `hint/route.ts` (`buildHint`) |
| Storage backend | new file in `lib/store/`, one branch in `index.ts` |
| Round selection strategy | `lib/game/round-builder.ts` |
| Error taxonomy | `lib/http/api-error.ts` |
| Anything reading env | `lib/config/env.ts` |

The score ladder the UI renders comes from `scoreLadder()`, and the rule-card
copy interpolates `MAX_ATTEMPT_HINTS` and `SECOND_HINT_COST`. The UI cannot
disagree with what the server enforces.
