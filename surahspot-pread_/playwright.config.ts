import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level tests.
 *
 * Run against a production build with the fixture upstream, not against
 * `next dev`. Two reasons: the dev build behaves differently in ways that
 * matter here (relaxed CSP, React strict double-invoke), and the fixtures mean
 * a full seven-round attempt costs no credentials, no network, and no Quran
 * Foundation quota — so this can run on every pull request.
 *
 * WebKit is not optional. Mobile Safari is where this app's media behaviour
 * diverges most: inline playback, seeking before metadata, and background
 * suspension are all things desktop Chrome will never catch.
 */

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * One source of truth for the harness environment.
 *
 * The build and the server must agree, and the command string is derived from
 * this object rather than written out alongside it — a key added to only one
 * of the two would otherwise go missing with no error anywhere.
 *
 * QF_MOCK_ACK_PRODUCTION_BUILD is what lets fixture data run under
 * `next start`, which sets NODE_ENV=production. ALLOW_SINGLE_INSTANCE_STORE
 * does the same for the in-memory store — accurate here, since the suite is
 * one process, rather than a workaround. QF_ENV is never read while QF_MOCK is
 * on; it stays "prelive" so this cannot be misread as hitting the live API.
 */
const harnessEnv = {
  QF_MOCK: "1",
  QF_MOCK_ACK_PRODUCTION_BUILD: "1",
  QF_ENV: "prelive",
  QF_CLIENT_ID: "e2e-client",
  QF_CLIENT_SECRET: "e2e-secret",
  ROUND_TOKEN_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  RATE_LIMIT_ENABLED: "false",
  ALLOW_SINGLE_INSTANCE_STORE: "1",
};

const envArgs = Object.entries(harnessEnv)
  .map(([key, value]) => `${key}=${value}`)
  .join(" ");

export default defineConfig({
  testDir: "./tests/e2e",
  // Each spec plays whole attempts through a real audio proxy; the default 30s
  // is tight once WebKit is buffering.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // A stray .only would silently shrink the suite in CI to one test.
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    {
      // The viewport where the layout, the touch targets and the safe-area
      // padding actually have to hold up.
      name: "mobile-safari",
      use: { ...devices["iPhone 14"] },
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
    },
  ],

  webServer: {
    // Build, then start, both through the env wrapper so this works on Windows.
    // Running `start` alone fails on a clean checkout with "Could not find a
    // production build", which says nothing about the actual mistake. Next's
    // incremental cache keeps the repeat cost small.
    command:
      `node scripts/with-env.mjs ${envArgs} -- npm run build` +
      ` && node scripts/with-env.mjs ${envArgs} PORT=${PORT} -- npm run start -- --port ${PORT}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    // Generous: this now includes a full production build on a cold cache.
    timeout: 300_000,
    env: harnessEnv,
  },
});