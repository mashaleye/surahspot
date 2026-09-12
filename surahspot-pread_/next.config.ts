import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Content Security Policy.
 *
 * The app loads no third-party resources at all: no scripts, no frames, no
 * fonts. Recitation audio is proxied through /api/quran/audio and the Quranic
 * face is vendored into public/fonts, so every directive stays on 'self'.
 *
 * 'unsafe-inline' is required for style-src because Next injects inline <style>
 * during hydration, and for script-src only in development, where the dev
 * overlay uses inline and eval'd code.
 */
function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    // No exception needed: the Quranic face is served from this origin.
    // scripts/fetch-font.mjs vendors it and `prebuild` refuses to build
    // without it, so this cannot silently degrade to a system font.
    "font-src 'self' data:",
    // Same-origin only: the browser never talks to Quran Foundation directly,
    // which is what keeps the client credentials server-side.
    isDev ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    // Production only. Over http://localhost this directive rewrites every
    // /_next/static request to https, where nothing is listening, so the dev
    // server loses all CSS and JS. Safari enforces it on loopback; Chrome
    // exempts loopback, so the breakage is browser-dependent. The same applies
    // to plain-HTTP LAN testing from a phone.
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy() },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Lets the audio element read the proxied stream without opting the whole
  // document into cross-origin isolation, which would break nothing here but
  // is stricter than this app needs.
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,

  // Produces .next/standalone: a self-contained server with only the packages
  // it actually imports. This is what the Dockerfile copies, and it is why the
  // runtime image does not need node_modules or a package manager.
  output: "standalone",

  eslint: {
    // Lint is a separate CI step. Failing `next build` on a style rule turns a
    // formatting nit into a deploy outage.
    ignoreDuringBuilds: true,
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
      {
        // Round payloads contain the answer, so they must never be cached by a
        // browser, proxy, or CDN.
        //
        // Scoped to the game and content endpoints rather than all of /api,
        // because a blanket no-store here also overrode the audio route's own
        // `private, max-age=300` — which meant every seek re-fetched the
        // chapter file from upstream. On a phone that made scrubbing unusable.
        source: "/api/:path(game|quran/round|quran/config|quran/search|quran/translate)*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0, must-revalidate" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
      {
        source: "/api/health",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
    ];
  },
};

export default nextConfig;
