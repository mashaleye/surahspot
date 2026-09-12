import { NextRequest, NextResponse } from "next/server";
import { getCatalog, languageCatalog } from "@/lib/quran/catalog";
import {
  ATTEMPT_COOKIE_NAME,
  loadAttempt,
} from "@/lib/game/attempt-service";
import { attemptProgress, hintStatus } from "@/lib/game/attempt";
import {
  MAX_ATTEMPT_HINTS,
  MAX_ATTEMPT_ROUNDS,
  MAX_TRIES_PER_ROUND,
  SECOND_HINT_COST,
  scoreLadder,
} from "@/lib/game/rules";
import { toErrorResponse } from "@/lib/http/api-error";

export const dynamic = "force-dynamic";

const ROUTE = "api/quran/config";

export async function GET(request: NextRequest) {
  try {
    const catalog = await getCatalog();

    // Progress is included so a returning browser can reconcile its local stats
    // against the server before the first round is requested — a refresh
    // mid-attempt no longer leaves the two disagreeing about the round number.
    const attempt = await loadAttempt(request.cookies.get(ATTEMPT_COOKIE_NAME)?.value);

    return NextResponse.json({
      chapters: catalog.chapters.map((chapter) => ({
        id: chapter.id,
        nameSimple: chapter.name_simple,
        nameComplex: chapter.name_complex,
        nameArabic: chapter.name_arabic,
        translatedName: chapter.translated_name?.name ?? "",
        versesCount: chapter.verses_count,
      })),
      languages: languageCatalog(catalog.translations),
      playableChapterCount: catalog.upstreamChapterIds.size || catalog.chapters.length,
      reciters: catalog.reciters.map((reciter) => ({
        id: reciter.id,
        name: reciter.name,
        style: reciter.style?.name ?? null,
        qirat: reciter.qirat?.name ?? null,
      })),
      // The client renders the rules rather than restating them, so the scoring
      // ladder and the copy can never drift from what the server enforces.
      rules: {
        maxRounds: MAX_ATTEMPT_ROUNDS,
        maxTriesPerRound: MAX_TRIES_PER_ROUND,
        maxHints: MAX_ATTEMPT_HINTS,
        secondHintCost: SECOND_HINT_COST,
        scoreLadder: scoreLadder(),
      },
      attempt: attempt
        ? { ...attemptProgress(attempt), hints: hintStatus(attempt) }
        : null,
    });
  } catch (error) {
    return toErrorResponse(error, ROUTE);
  }
}
