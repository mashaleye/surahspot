# Testing

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm test                 # vitest: unit + integration  (206 tests, ~4s)
npm run test:e2e         # playwright: chromium, webkit, mobile
npm run test:all         # all of the above
```

Everything runs against the fixture upstream (`QF_MOCK=1`). No Quran Foundation
credentials, no network, no upstream quota — so the full suite runs on a forked
pull request and costs nothing per run.

## Three layers

**Vitest unit** (`tests/unit/`) — pure functions with no I/O. Scoring, attempt
transitions, token crypto, timing normalization, Juz boundaries, SSRF checks,
text sanitization. Milliseconds each, so they can be exhaustive.

**Vitest integration** (`tests/integration/`) — the real route handlers, imported
directly and called with a `NextRequest`. No server starts. `RouteClient` keeps a
cookie jar, because the attempt cookie is the mechanism tying a token to a
browser and a test that dropped it would pass while the real flow broke.

**Store contract** (`tests/integration/store.test.ts`) — one suite run against
*both* backends, because the whole point of `KeyValueStore` is that the layers
above cannot tell them apart. A behaviour that holds in memory but not in Redis
would be a bug that only appears in production. The Redis cases skip themselves
when no server is reachable so `npm test` works on a bare machine; CI runs a
Redis service **and then asserts nothing was skipped**, because a skip that
quietly becomes permanent is how an untested backend ships.

Beyond the shared contract, the Redis suite targets what is easy to get wrong in
a hand-written RESP client: replies split across TCP segments, pipelined
commands staying matched to their callers, a 200KB value, compare-and-delete
lock ownership, and a corrupt value not poisoning every later read.

**Playwright e2e** (`tests/e2e/`) — a production build in a real browser.
Reserved for things the other two layers cannot see: dropdown dismissal, Space
handling while typing, safe-area layout, and iOS media behaviour.

WebKit is not optional in CI. Mobile Safari is where this app's audio diverges —
inline playback, seeking before metadata, background suspension — and desktop
Chrome will never stand in for it.

## Coverage against the test plan

| Plan section | Where |
|---|---|
| A. Core gameplay & scoring (TC-001–015) | `unit/rules`, `integration/game-flow`, `e2e/gameplay` |
| B. Attempt state & randomization (TC-016–027) | `unit/attempt`, `integration/game-flow` |
| C. Search & autocomplete (TC-028–039) | `integration/api-surface`, `e2e/gameplay` |
| D. Hints — functional (TC-040–052) | `unit/rules`, `unit/attempt`, `integration/game-flow` |
| E. Hint anti-cheat & races (TC-053–061) | `integration/game-flow`, `unit/round-token` |
| F. Audio playback (TC-062–071) | `e2e/gameplay`, `integration/api-surface` |
| G. Karaoke mapping (TC-072–082) | `unit/karaoke` |
| H. Arabic & translation (TC-083–092) | `unit/quran-text`, `e2e/gameplay` |
| I. Network & reliability (TC-093–100) | `integration/api-surface` |

The 15 cases flagged in the plan as highest-value to automate — TC-002–007, 015,
017, 037, 043, 054–056, 063, 097 — are all covered.

## Race conditions

Concurrency cases are tested with genuine parallel requests, not sequential calls
pretending to be parallel:

```ts
const results = await Promise.all([
  client.post(hintRoute, HINT_URL, { token, type: "meaning" }),
  client.post(hintRoute, HINT_URL, { token, type: "ayah_count" }),
]);
expect(results.filter(r => r.status === 200)).toHaveLength(1);
```

This is what verifies `withLock` actually serializes rather than merely existing.

## Bugs this suite caught while being written

Worth recording, because they justify the layers:

- **Rate-limit bypass.** The bucket key was the attempt cookie when present, IP
  otherwise. Since `/api/quran/round` *issues* the cookie on its first response,
  every caller moved to a fresh bucket after one request and the limit never
  fired. Only a multi-request integration test shows this.
- **Local search 500s.** `normalizeSurahQuery(chapter.name_complex)` threw on a
  catalog record missing that field — inside the upstream-failure fallback, so a
  Search outage became a hard 500 on every query instead of a graceful
  degradation.
- **IPv6 SSRF hole.** The check looked for `::ffff:169.254.169.254`, but the URL
  parser rewrites it to `::ffff:a9fe:a9fe`. The hex form walked straight through
  to the cloud metadata endpoint.
- **`/api/health` masking its own fix.** A store misconfiguration reported as
  "store unavailable" left an operator with a 503 and no way to learn the remedy
  was one environment variable. Configuration errors — which contain no
  credentials or player data — are now shown verbatim.
- **`/api/health` crashing.** With `QF_MOCK=1` and `NODE_ENV=production` the
  config getter threw, the handler produced no body, and an orchestrator would
  see a connection reset — indistinguishable from a dead process. It now returns
  503 with the reason.

## Architecture decisions the tests enforce

Two settings are fail-closed, and the suite covers both refusal paths:

- Production without `ATTEMPT_STORE_URL` and without
  `ALLOW_SINGLE_INSTANCE_STORE=1` refuses to start.
- A build without `public/fonts/UthmanicHafs1Ver18.ttf` refuses to complete.

Both guard failures that are otherwise *silent*: extra hints on a second
replica, and Arabic rendered in a system font. Neither would ever appear in a
test result, which is why they are configuration refusals rather than assertions.

## Notable test seams

`vitest.config.ts` aliases `server-only` to an empty stub. The real package
throws unless a bundler marked the graph server-side — which is the protection we
want in `next build` and exactly what makes route handlers unimportable in
Vitest. The stub keeps both.

`tests/setup.ts` clears every `__surahspot*` global before each test, since the
store, token cache, and catalog cache live on `globalThis` to survive hot reload.

## Manual checks still worth doing

Automation does not cover perceptual sync. Before a release, on a real phone:

1. Play a full Ayah and watch the highlight track the recitation.
2. Seek backward and forward; confirm audio and highlight move together.
3. Change speed to 0.75× and 1.25×; confirm sync holds.
4. Lock the phone mid-playback, unlock, and confirm the highlight re-syncs.
5. Confirm playback stops at the Ayah end and does not spill into the next.

See `docs/DEPLOYMENT.md` for getting the dev server onto a phone.
