import { NextRequest, NextResponse } from "next/server";
import { type Catalog, type Chapter, getCatalog, searchChaptersLocally } from "@/lib/quran/catalog";
import { qfSearch } from "@/lib/quran/client";
import { badRequest, toErrorResponse } from "@/lib/http/api-error";
import { enforceRateLimit, rateLimitIdentities } from "@/lib/http/rate-limit";
import { ATTEMPT_COOKIE_NAME } from "@/lib/game/attempt-service";
import { rateLimits } from "@/lib/config/env";

export const dynamic = "force-dynamic";

const ROUTE = "api/quran/search";
const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 25;

function toSurahSummary(chapter: Chapter) {
  return {
    id: chapter.id,
    nameSimple: chapter.name_simple,
    nameComplex: chapter.name_complex,
    nameArabic: chapter.name_arabic,
    translatedName: chapter.translated_name?.name ?? "",
    versesCount: chapter.verses_count,
  };
}

export async function GET(request: NextRequest) {
  try {
    const query = (request.nextUrl.searchParams.get("query") ?? "").trim();
    if (!query) return NextResponse.json({ surahs: [], source: "empty" });

    // Bounded before any upstream call, so an abusive query costs nothing.
    if (query.length > MAX_QUERY_LENGTH) {
      throw badRequest("Search query is too long.");
    }

    const limits = rateLimits();
    if (limits.enabled) {
      const attemptId = request.cookies.get(ATTEMPT_COOKIE_NAME)?.value;
      await enforceRateLimit("search", rateLimitIdentities(request, attemptId), limits.searchPerMinute);
    }

    const catalog = await getCatalog();
    const { surahs, source } = await searchSurahs(catalog, query);

    return NextResponse.json({ surahs, source });
  } catch (error) {
    return toErrorResponse(error, ROUTE);
  }
}

/**
 * Resolve a query to Surahs, preferring Quran Foundation Quick Search.
 *
 * Two properties matter here and neither is negotiable:
 *
 * 1. Only `result_type: "surah"` navigation results are forwarded. QF quick
 *    search also returns matching ayahs, juzs and pages — forwarding those
 *    would let a player paste the Arabic they are looking at into the answer
 *    box and be told which Surah it comes from, which is the entire game.
 *
 * 2. Search failure must never block answering. The local catalog is the
 *    fallback, so a QF outage, a missing `search` scope, or a rate limit
 *    degrades result quality instead of making the game unplayable.
 */
async function searchSurahs(catalog: Catalog, query: string) {
  try {
    const search = await qfSearch(query, {
      navigationalResultsNumber: MAX_RESULTS,
      versesResultsNumber: 1,
    });

    const orderedChapterIds = (search.result?.navigation ?? [])
      .filter((item) => item.result_type === "surah")
      .map((item) => Number(item.key))
      .filter((id) => Number.isInteger(id) && id >= 1 && id <= 114);

    const seen = new Set<number>();
    const surahs = orderedChapterIds.flatMap((id) => {
      if (seen.has(id)) return [];
      seen.add(id);
      const chapter = catalog.chapters.find((candidate) => candidate.id === id);
      return chapter ? [toSurahSummary(chapter)] : [];
    });

    if (surahs.length) return { surahs, source: "quran-foundation" as const };

    // QF found nothing usable. The local index still might — it matches on
    // Surah number and Arabic name, which quick search ranks differently.
    return {
      surahs: searchChaptersLocally(catalog, query, MAX_RESULTS).map(toSurahSummary),
      source: "local" as const,
    };
  } catch (error) {
    console.warn(`[${ROUTE}] upstream search unavailable, using local catalog`, error);
    return {
      surahs: searchChaptersLocally(catalog, query, MAX_RESULTS).map(toSurahSummary),
      source: "local" as const,
    };
  }
}
