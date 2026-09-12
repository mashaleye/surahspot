import { NextRequest, NextResponse } from "next/server";
import { getCatalog } from "@/lib/quran/catalog";
import { sealRound } from "@/lib/quran/round-token";
import { buildRound, sanitizeExcludedChapters } from "@/lib/game/round-builder";
import {
  ATTEMPT_COOKIE_NAME,
  attemptCookieOptions,
  createAttempt,
  loadAttempt,
  loadOrCreateAttempt,
  newRoundId,
  saveAttempt,
} from "@/lib/game/attempt-service";
import { attemptProgress, canStartNewAttempt, hintStatus, registerRound } from "@/lib/game/attempt";
import { MAX_TRIES_PER_ROUND, STARTING_POINTS } from "@/lib/game/rules";
import { conflict, toErrorResponse } from "@/lib/http/api-error";
import { enforceRateLimit, rateLimitIdentities } from "@/lib/http/rate-limit";
import { rateLimits } from "@/lib/config/env";

export const dynamic = "force-dynamic";

const ROUTE = "api/quran/round";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const language = typeof body.language === "string" ? body.language : "english";
    const preferredReciterId = Number.isFinite(Number(body.reciterId)) ? Number(body.reciterId) : undefined;
    const excludedChapterIds = sanitizeExcludedChapters(body.excludeChapterIds);

    // Hint allowance and round count are attempt-scoped and live behind an
    // HttpOnly cookie plus server-side state. The browser never gets to declare
    // how many hints it has used or how far into the attempt it is.
    const cookieAttemptId = request.cookies.get(ATTEMPT_COOKIE_NAME)?.value;

    const limits = rateLimits();
    if (limits.enabled) {
      // Building a round fans out to several upstream calls, so it carries the
      // tightest budget of any endpoint.
      await enforceRateLimit("round", rateLimitIdentities(request, cookieAttemptId), limits.roundPerMinute);
    }

    const existingAttempt = await loadAttempt(cookieAttemptId);
    const wantsNewAttempt = body.newAttempt === true;
    if (wantsNewAttempt && !canStartNewAttempt(existingAttempt)) {
      throw conflict("The current seven-round attempt is still active.");
    }

    const attempt = wantsNewAttempt
      ? await createAttempt()
      : (existingAttempt ?? await loadOrCreateAttempt(null));

    const catalog = await getCatalog();
    const round = await buildRound({ catalog, language, preferredReciterId, excludedChapterIds });

    // Registering the round throws once the attempt has used its seven, which
    // is the server-side backstop for a client that tampered with its own round
    // counter in localStorage.
    const registration = registerRound(attempt, newRoundId());
    await saveAttempt(attempt);

    const token = sealRound({
      verseKey: round.verseKey,
      chapterId: round.chapterId,
      reciterId: round.audio.reciterId,
      audioUrl: round.audio.url,
      attemptsUsed: 0,
      hintPenalty: 0,
      attemptId: attempt.id,
      roundId: registration.roundId,
      revision: registration.revision,
      issuedAt: Date.now(),
    });

    const response = NextResponse.json({
      token,
      words: round.words,
      arabic: round.arabic,
      transliteration: round.transliteration,
      translation: round.translation,
      translationMeta: round.translationMeta,
      audio: {
        // The upstream URL is never sent: its filename encodes the chapter
        // number, which is the answer. The proxy resolves it from the token.
        url: `/api/quran/audio?token=${encodeURIComponent(token)}`,
        fromMs: round.audio.fromMs,
        toMs: round.audio.toMs,
        segments: round.audio.segments,
        reciter: round.audio.reciter,
        reciterId: round.audio.reciterId,
        requestedReciterId: round.audio.requestedReciterId,
        usedFallbackReciter: round.audio.usedFallbackReciter,
      },
      attemptsRemaining: MAX_TRIES_PER_ROUND,
      pointsRemaining: STARTING_POINTS,
      hints: hintStatus(attempt),
      // Echoed so a client whose localStorage was cleared, tampered with, or
      // left behind by a refresh can reconcile against the server's count.
      progress: attemptProgress(attempt),
    });

    response.cookies.set(ATTEMPT_COOKIE_NAME, attempt.id, attemptCookieOptions());
    return response;
  } catch (error) {
    return toErrorResponse(error, ROUTE);
  }
}
