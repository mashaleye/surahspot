# syntax=docker/dockerfile:1.7

# SurahSpot production image.
#
# Three stages so the runtime layer carries only what serving needs: no package
# manager, no dev dependencies, no source. Next's standalone output traces the
# modules actually imported and emits a self-contained server, which is why the
# final stage never runs npm install.

# ---------------------------------------------------------------------------
# deps — install with the lockfile, cached independently of source changes
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Only the manifests, so editing a component does not invalidate this layer.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# builder — typecheck and build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build-time placeholders. Nothing here reaches the image: these exist only so
# module-level configuration validation does not fail during the build, and the
# real values arrive as runtime environment variables. The token secret in
# particular is never used to seal anything — the server re-reads it per
# request, so an unset secret at runtime fails loudly rather than silently
# using this one.
ARG QF_ENV=production
ENV QF_ENV=$QF_ENV

# Vendor the Quranic font into public/fonts. The build refuses to proceed
# without it, because the CSP permits no cross-origin fallback and shipping
# without the face would render the Arabic in a system font with no error
# anywhere. Needs network at build time; for an air-gapped build, place the
# .ttf in public/fonts before building and this becomes a no-op.
RUN npm run fetch:font

RUN npm run typecheck
RUN npm run build

# ---------------------------------------------------------------------------
# runner — minimal runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Bind to every interface: inside a container, localhost is unreachable from
# the host and from a load balancer.
ENV HOSTNAME=0.0.0.0

# Run unprivileged. The node image ships a `node` user for exactly this.
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
# Static assets are not traced into standalone and have to be copied alongside.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000

# Liveness only: this deliberately does not use ?deep=1, because a Quran
# Foundation outage would otherwise mark every replica unhealthy and get them
# all restarted, turning a degraded upstream into a total one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
