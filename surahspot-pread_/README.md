# SurahSpot

A Quran listening-and-recognition game. A complete Ayah is recited with
word-level Arabic highlighting; the player has five tries to identify the Surah.
Each attempt runs seven rounds.

```bash
cp .env.example .env.local     # add Quran Foundation credentials
npm install                    # also vendors the Quranic font
npm run dev                    # http://localhost:3000
```

If the font fetch was skipped (offline, or a restricted network), run
`npm run fetch:font` before building — `npm run build` refuses without it.

No credentials to hand? `npm run dev:mock` runs against a built-in fixture
upstream.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — layering, the store
  abstraction, and why each boundary is where it is
- **[docs/TESTING.md](docs/TESTING.md)** — the suite and how it maps to the QA plan
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — production setup and phone testing

## Gameplay

- Five tries per round: **100 / 80 / 60 / 40 / 20**, then 0.
- **Skip this try** spends one try; **Skip round** ends the Ayah at 0 points.
- Seven rounds per attempt, no Surah repeated.
- Two hints per *attempt* — first free, second costs 3 points in its round.
  Choose: name meaning, Ayah count, the current Ayah's Juz, or Makki/Madani.
- Surah selected first and uniformly, then an Ayah within it, so Al-Baqarah is
  no likelier than Al-Kawthar.

## Scripts

| | |
|---|---|
| `npm run dev` / `dev:phone` / `dev:mock` | local, LAN-accessible, fixture upstream |
| `npm run build` / `start` | production build and server |
| `npm test` / `test:e2e` / `test:all` | vitest, playwright, everything |
| `npm run typecheck` / `lint` | tsc, eslint |
| `npm run check:credentials` | test a QF client ID/secret against both environments |
| `npm run verify:deploy` | pre-flight configuration check |

## Security posture

- The answer never reaches the browser. Chapter and verse key are AES-256-GCM
  sealed in an opaque round token; audio streams through a Range-capable proxy so
  the chapter-numbered upstream filename never appears in DevTools.
- Hint state is server-side behind an HttpOnly, SameSite=Strict cookie. The
  browser learns only how many hints remain and the one it purchased.
- Every mutation rotates a server-side round revision and reissues the token, so
  a token saved before a paid hint cannot be replayed to dodge the deduction.
  Parallel actions on one attempt are serialized.
- Search forwards Surah navigation results only. Pasting the visible Ayah into
  the answer box cannot return a verse reference.
- The audio proxy accepts only public https hosts, blocking loopback, RFC1918,
  CGNAT, IPv6 unique-local, IPv4-mapped forms, and `169.254.0.0/16` — the cloud
  instance metadata range.
- Rate limiting counts against IP *and* attempt cookie.
- Unexpected errors return a generic message plus a request id in production; the
  detail goes to the server log under that id.

### Storage is fail-closed

Production **refuses to start** without `ATTEMPT_STORE_URL` unless you set
`ALLOW_SINGLE_INSTANCE_STORE=1`.

That is deliberate. The in-memory store enforces the two-hint limit, the
round-replay guard and the seven-round ceiling only within one process. Across
replicas they stop holding — and they do it silently: nothing errors, no metric
moves, players just quietly get extra hints. A misconfiguration whose only
symptom is "the rules no longer apply" has to fail at deploy time, so the health
endpoint returns 503 with the exact fix rather than serving a broken game.

Single-instance deployments are legitimate; they just say so out loud.

### The font is self-hosted

`public/fonts/UthmanicHafs1Ver18.ttf` is vendored by `npm run fetch:font` and the
CSP is `font-src 'self' data:` with no cross-origin exception.

The previous cross-origin arrangement required the stylesheet and the CSP to
agree about an external origin; when they drifted the font was blocked, the
Arabic fell back to a system face, and nothing errored. `prebuild` now verifies
the file (size plus TrueType magic bytes, so a 404 HTML page saved as `.ttf`
fails too), which makes that regression unshippable.

## Stack

Next.js 15 · React 19 · TypeScript · Quran Foundation Content & Search APIs
(OAuth2 client credentials) · native HTML Audio.

Runtime dependencies: `next`, `react`, `react-dom`, `server-only`. The Redis
client is written directly against RESP rather than pulling in ioredis, and the
cross-platform env wrapper replaces `cross-env`.

## Design direction

Borrows *principles* rather than pixels: Quran.com-style warm neutral surfaces,
emerald accents, generous Arabic typography, reading-first hierarchy. The loop is
Songspot-like — listen, search, guess or skip — adapted so each clue is the
complete Ayah rather than a progressively longer snippet.
