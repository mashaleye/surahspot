import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { isProduction, qfEnvironment, mockUpstreamEnabled } from "@/lib/config/env";
import { isConfigurationError } from "@/lib/http/api-error";
import { getCatalog } from "@/lib/quran/catalog";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness probe.
 *
 * Two depths, because orchestrators ask two different questions:
 *
 * - `GET /api/health` is liveness. It checks only that the process is running
 *   and the store answers. It must stay cheap and must not call Quran
 *   Foundation, or a QF blip would make every replica look unhealthy and get
 *   them all restarted — turning a degraded upstream into a total outage.
 * - `GET /api/health?deep=1` additionally warms and verifies the catalog. Use
 *   it for a post-deploy smoke check, not for the load balancer.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const deep = request.nextUrl.searchParams.get("deep") === "1";

  const checks: Record<string, unknown> = {};
  let healthy = true;

  // The health endpoint must never throw. If it does, the orchestrator sees a
  // connection reset rather than a body, which is indistinguishable from the
  // process being dead — so a misconfiguration that the app could report
  // clearly instead looks like a crash loop. Every probe below is therefore
  // guarded and downgrades to "degraded" with a reason.
  let storeName = "unknown";
  let storeOk = false;
  try {
    const store = getStore();
    storeName = store.name;
    storeOk = await store.ping();
  } catch (error) {
    // A configuration failure is an instruction for whoever is deploying, and
    // it contains no credentials or player data — so it is shown verbatim even
    // in production. Hiding it behind "store unavailable" would leave an
    // operator staring at a 503 with no way to learn that the fix is one
    // environment variable. Anything else is reported opaquely.
    checks.storeError = isConfigurationError(error)
      ? (error as Error).message
      : isProduction()
        ? "store unavailable"
        : String(error);
  }
  checks.store = { backend: storeName, ok: storeOk };
  if (!storeOk) healthy = false;

  // Configuration is read inside the try because several getters throw by
  // design on an invalid value — that is what stops a bad QF_ENV from silently
  // pointing at the wrong authorization server.
  let configuration: { environment: string; mockUpstream: boolean };
  try {
    configuration = { environment: qfEnvironment(), mockUpstream: mockUpstreamEnabled() };
    checks.configuration = { ok: true };
  } catch (error) {
    healthy = false;
    configuration = { environment: "invalid", mockUpstream: false };
    // This message is an operator instruction, not player-facing data, and it
    // never contains credentials — so it is shown in every environment.
    checks.configuration = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (deep) {
    try {
      const catalog = await getCatalog();
      checks.catalog = {
        ok: true,
        chapters: catalog.chapters.length,
        playableChapters: catalog.upstreamChapterIds.size,
        reciters: catalog.reciters.length,
        translations: catalog.translations.length,
      };
    } catch (error) {
      healthy = false;
      checks.catalog = {
        ok: false,
        error: isProduction() ? "catalog unavailable" : String(error),
      };
    }
  }

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      // Deliberately not the package version or a commit SHA by default:
      // an unauthenticated endpoint should not advertise what is deployed.
      environment: configuration.environment,
      mockUpstream: configuration.mockUpstream,
      uptimeSeconds: Math.round(process.uptime()),
      durationMs: Date.now() - startedAt,
      checks,
    },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
