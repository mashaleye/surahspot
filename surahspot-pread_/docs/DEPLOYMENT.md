# Deployment

## Before you deploy

```bash
node --env-file=.env.production scripts/verify-deployment.mjs
```

Every check it makes corresponds to a failure that is silent or that only appears
under production conditions — a hint allowance that resets because the store is
process-local, an Arabic font blocked by the app's own CSP, a fixture upstream
left switched on. None of these break `npm run dev`, which is exactly why they
need their own gate.

Then, once running:

```bash
curl -sS https://YOUR_HOST/api/health          # liveness
curl -sS https://YOUR_HOST/api/health?deep=1   # + catalog reachability
```

## Choosing a target

The decision that matters is **how many processes serve traffic**.

| Target | Configuration |
|---|---|
| Multiple replicas, serverless | `ATTEMPT_STORE_URL=rediss://…` |
| Single VM / container | `ALLOW_SINGLE_INSTANCE_STORE=1` |

Production will not start on the in-memory store without that acknowledgement.
The health endpoint returns 503 with the exact remedy, so the container fails its
check and never receives traffic.

This is fail-closed on purpose. Running multi-instance without shared storage is
not a performance problem, it is a correctness one — a player landing on a second
replica gets a fresh two-hint allowance, and the round-revision replay guard has
nothing to compare against. Nothing logs an error when that happens, which is
precisely why the configuration has to refuse rather than warn.

## Docker

```bash
docker build -t surahspot .
docker run -p 3000:3000 \
  -e QF_ENV=production \
  -e QF_CLIENT_ID=... \
  -e QF_CLIENT_SECRET=... \
  -e ROUND_TOKEN_SECRET=$(openssl rand -hex 32) \
  surahspot
```

The image is built from Next's standalone output: the runtime stage has no
package manager, no dev dependencies, and no source. It runs as the unprivileged
`node` user and its `HEALTHCHECK` uses liveness only — a deep check would mark
every replica unhealthy during a Quran Foundation blip and restart them all,
turning a degraded upstream into a total outage.

Pass `ALLOW_SINGLE_INSTANCE_STORE=1` for a single container, or
`ATTEMPT_STORE_URL` for anything scaled.

`.dockerignore` excludes every `.env*` except the template. Anything copied into
a layer stays recoverable from the image even if a later layer deletes it.

## With Redis

```bash
docker compose up --build
```

`docker-compose.yml` exists mainly so you can *exercise* the shared store. It is
the only way to verify that the two-hint limit and the replay guard survive more
than one process — `npm run dev` cannot show you that.

Use `rediss://` for any remote Redis so attempt ids don't cross the network in
the clear.

## Secrets

`ROUND_TOKEN_SECRET` encrypts the round token, which carries the answer. Generate
it with `openssl rand -hex 32`; anything under 32 characters is refused at
startup.

Rotating it invalidates every in-flight round token, so players mid-attempt see
"start a new round". Rotate at a quiet hour.

**The repository you sent contained a live `.env.local`.** Those credentials
should be treated as disclosed and regenerated in the Quran Foundation Developer
Console. `.gitignore` and `.dockerignore` now both exclude it.

## The font

The Quranic face is self-hosted. `npm run fetch:font` vendors it into
`public/fonts/`, the CSP is `font-src 'self' data:` with no exception, and
`prebuild` refuses to build without it.

Verification checks size *and* TrueType magic bytes, because the realistic
failure is a 404 HTML page saved to a `.ttf` path — which a size check alone
would pass and which renders as nothing.

The Docker build runs `fetch:font`, so it needs network at build time. For an
air-gapped build, drop the `.ttf` into `public/fonts/` beforehand and the step
becomes a no-op.

On licensing: the KFGQPC Uthmanic Hafs face is published by the King Fahd
Glorious Quran Printing Complex for Quranic use. It is fetched at setup rather
than committed, so the terms travel with the source you obtain it from. Review
them before redistributing this repository with the binary included.

## Rate limiting

On by default in production. One round request fans out to several upstream
calls, so this protects the Quran Foundation quota as much as the server — an
unthrottled loop takes the game down for everyone.

Requests are counted against **both** the caller's IP and their attempt cookie.
Either alone is a bypass: cookie-only resets when cookies are cleared, IP-only
punishes everyone behind one carrier NAT.

---

# Testing on a phone

Three options, in order of what to reach for first.

## 1. Same Wi-Fi (fastest)

```bash
npm run dev:phone     # next dev -H 0.0.0.0 -p 3000
```

Then open `http://YOUR_LOCAL_IP:3000` on the phone — not `localhost`, which on
the phone means the phone.

Find the IP with `ipconfig getifaddr en0` (macOS) or `ipconfig` (Windows).

If it won't connect, the usual cause is the computer's firewall blocking inbound
connections to `node` on port 3000. Guest, hotel, and many apartment networks
also use client isolation, which prevents devices on the same Wi-Fi from talking
to each other at all — use a tunnel in that case.

The attempt cookie works over plain-HTTP LAN because `secure` is tied to
`NODE_ENV === "production"`. Hard-coding `secure: true` would silently break
hints on every LAN test.

## 2. Cloudflare Tunnel (realistic HTTPS)

```bash
npm run dev
cloudflared tunnel --url http://localhost:3000
```

Gives a real HTTPS URL, which is what you want for testing cookies, mobile
Safari media behaviour, and anything security-related. `ngrok http 3000` is
equivalent.

## 3. Tailscale (private, across networks)

Best when the phone isn't on the same Wi-Fi and you don't want a public URL.
With `npm run dev:phone` running, open `http://100.x.x.x:3000` on the phone, or
use MagicDNS.

One thing to know: Tailscale's `100.64.0.0/10` range is blocked by the audio
proxy's SSRF guard. That is intentional and does not affect testing over
Tailscale — the guard applies to *outbound* upstream audio URLs, not to inbound
requests.

**Do not port-forward the dev server from your router.** The Next dev server
exposes source maps, error detail, and debug routes.

## What to check on-device

The media path is where phones differ most:

```
play → pause → seek forward → seek backward
     → lock phone → unlock → switch apps → return
```

Watch that the highlight re-syncs rather than drifting. Mobile Safari
specifically: confirm playback stays inline (no fullscreen takeover), that the
first play starts at the Ayah and not the top of the chapter file, and that
tapping the answer field doesn't zoom the page.
