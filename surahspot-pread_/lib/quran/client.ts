import { qfCredentials, qfEnvironment, timeouts, mockUpstreamEnabled } from "@/lib/config/env";
import { AppError, upstreamError } from "@/lib/http/api-error";
import { MockUpstreamError, mockContentRequest, mockSearch } from "./mock-upstream";

/**
 * HTTP client for the Quran Foundation Content and Search APIs.
 *
 * Changes from the original inline version, all of them things that only show
 * up under production conditions:
 *
 * - Every request has a deadline. A hung upstream previously held a Next route
 *   handler open indefinitely; enough of those and the process stops serving.
 * - 429 and 5xx are classified rather than flattened into one generic Error,
 *   so the round builder can tell "this reciter lacks this chapter" (recoverable,
 *   try another) from "upstream is down" (not recoverable, surface it).
 * - Tokens are refreshed at most once per request and the refresh is shared, so
 *   a burst of expiries does not trigger a burst of token requests.
 * - QF_MOCK short-circuits to fixtures before any network call.
 */

const PRELIVE_AUTH = "https://prelive-oauth2.quran.foundation";
const PRELIVE_API = "https://apis-prelive.quran.foundation";
const PROD_AUTH = "https://oauth2.quran.foundation";
const PROD_API = "https://apis.quran.foundation";

type Json = Record<string, unknown>;
type Scope = "content" | "search";

type CachedToken = { token: string; expiresAt: number };

type ClientGlobals = typeof globalThis & {
  __surahspotTokenCache?: Map<Scope, CachedToken>;
  __surahspotTokenInflight?: Map<Scope, Promise<string>>;
};

const globals = globalThis as ClientGlobals;
const tokenCache = globals.__surahspotTokenCache ??= new Map<Scope, CachedToken>();
const tokenInflight = globals.__surahspotTokenInflight ??= new Map<Scope, Promise<string>>();

/** Renew this far before expiry so a token cannot lapse mid-request. */
const TOKEN_SKEW_MS = 60_000;

export function endpoints() {
  const env = qfEnvironment();
  return {
    env,
    authBase: env === "production" ? PROD_AUTH : PRELIVE_AUTH,
    apiBase: env === "production" ? PROD_API : PRELIVE_API,
  };
}

/**
 * Upstream failure with the status attached.
 *
 * The round builder needs to branch on the status — a 404 means "this reciter
 * does not cover this chapter, try another", a 503 means "stop". The old code
 * recovered the status by regex-matching the message text, which broke as soon
 * as an error message changed wording.
 */
export class QuranApiError extends AppError {
  constructor(readonly status: number, message: string, context?: Record<string, unknown>) {
    super(status === 429 ? "rate_limited" : "upstream", message, { context });
    this.name = "QuranApiError";
  }

  /** Worth trying a different reciter, chapter, or ayah for. */
  get isRecoverable() {
    return this.status === 404 || this.status === 422 || (this.status >= 500 && this.status <= 504);
  }
}

export function isRecoverableUpstream(error: unknown) {
  return error instanceof QuranApiError && error.isRecoverable;
}

async function fetchWithDeadline(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new QuranApiError(504, `Quran Foundation did not respond within ${timeoutMs}ms.`, { url });
    }
    throw upstreamError("Could not reach Quran Foundation.", { cause: error, context: { url } });
  } finally {
    clearTimeout(timer);
  }
}

async function requestToken(scope: Scope, force = false): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(scope);
  if (!force && cached && cached.expiresAt - TOKEN_SKEW_MS > now) return cached.token;

  // Collapse concurrent refreshes. Without this, a burst of requests arriving
  // just after expiry each issues its own token call.
  const inflight = tokenInflight.get(scope);
  if (inflight && !force) return inflight;

  const pending = (async () => {
    const { clientId, clientSecret } = qfCredentials();
    const { authBase, env } = endpoints();
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const response = await fetchWithDeadline(
      `${authBase}/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "client_credentials", scope }),
      },
      timeouts().upstreamMs,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Name the environment that was actually used. A 401 invalid_client here
      // is almost always credentials issued for the *other* environment, since
      // QF provisions prelive and production apps separately.
      const hint = response.status === 401
        ? ` Check that these credentials were issued for the "${env}" environment and that the Developer Console app is a Backend/server app.`
        : "";
      throw new QuranApiError(
        response.status,
        `Quran Foundation ${scope} token request failed (${response.status}) at ${authBase} using QF_ENV="${env}".${hint}`,
        { body: text.slice(0, 300) },
      );
    }

    const data = await response.json() as { access_token: string; expires_in?: number };
    tokenCache.set(scope, {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    });
    return data.access_token;
  })().finally(() => {
    if (tokenInflight.get(scope) === pending) tokenInflight.delete(scope);
  });

  tokenInflight.set(scope, pending);
  return pending;
}

/** Test seam: drop cached tokens so a suite can assert the refresh path. */
export function resetTokenCache() {
  tokenCache.clear();
  tokenInflight.clear();
}

export async function qfFetch<T extends Json = Json>(path: string, init?: RequestInit, retry = true): Promise<T> {
  if (mockUpstreamEnabled()) {
    try {
      return mockContentRequest(path) as T;
    } catch (error) {
      if (error instanceof MockUpstreamError) throw new QuranApiError(error.status, error.message, { path });
      throw error;
    }
  }

  const { clientId } = qfCredentials();
  const { apiBase } = endpoints();
  const token = await requestToken("content");

  const response = await fetchWithDeadline(
    `${apiBase}/content/api/v4${path}`,
    {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        "x-auth-token": token,
        "x-client-id": clientId,
        Accept: "application/json",
      },
    },
    timeouts().upstreamMs,
  );

  if (response.status === 401 && retry) {
    await requestToken("content", true);
    return qfFetch<T>(path, init, false);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new QuranApiError(
      response.status,
      `Quran Foundation API failed (${response.status}) for ${path}.`,
      { body: text.slice(0, 400) },
    );
  }

  return response.json() as Promise<T>;
}

export type QfSearchResult = {
  result_type: "surah" | "juz" | "hizb" | "ayah" | "rub_el_hizb" | "search_page" | "page" | "range" | "quran_range";
  key: number | string;
  name: string;
  arabic?: string;
  isArabic?: boolean;
  isTransliteration?: boolean;
};

export type QfSearchResponse = {
  pagination?: {
    current_page: number;
    next_page: number | null;
    per_page: number;
    total_pages: number;
    total_records: number;
  };
  result?: {
    navigation?: QfSearchResult[];
    verses?: QfSearchResult[];
  };
};

/**
 * Server-only Quran Foundation Search helper.
 *
 * Search uses its own client-credentials token because QF grants the `search`
 * scope independently from `content`.
 */
export async function qfSearch(
  query: string,
  options: { navigationalResultsNumber?: number; versesResultsNumber?: number } = {},
  retry = true,
): Promise<QfSearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) return { result: { navigation: [], verses: [] } };

  if (mockUpstreamEnabled()) return mockSearch(trimmed);

  const { clientId } = qfCredentials();
  const { apiBase } = endpoints();
  const token = await requestToken("search");

  const params = new URLSearchParams({
    mode: "quick",
    query: trimmed,
    navigationalResultsNumber: String(options.navigationalResultsNumber ?? 20),
    // The game intentionally does not need verse hits in the answer picker.
    // Requesting one keeps this within QF's documented >=1 range, and the
    // search route drops them before anything reaches the browser.
    versesResultsNumber: String(options.versesResultsNumber ?? 1),
  });

  const response = await fetchWithDeadline(
    `${apiBase}/search/api/v1/search?${params.toString()}`,
    {
      headers: {
        "x-auth-token": token,
        "x-client-id": clientId,
        Accept: "application/json",
      },
    },
    timeouts().upstreamMs,
  );

  if (response.status === 401 && retry) {
    await requestToken("search", true);
    return qfSearch(query, options, false);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new QuranApiError(
      response.status,
      `Quran Foundation Search API failed (${response.status}).`,
      { body: text.slice(0, 400) },
    );
  }

  return response.json() as Promise<QfSearchResponse>;
}
