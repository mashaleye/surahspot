import { NextRequest, NextResponse } from "next/server";
import { findChapter, getCatalog } from "@/lib/quran/catalog";
import { openRound, sealRound } from "@/lib/quran/round-token";
import {
  ATTEMPT_COOKIE_NAME,
  mutateAttempt,
} from "@/lib/game/attempt-service";
import {
  assertRoundActive,
  attemptProgress,
  finishRound,
  rotateRoundRevision,
} from "@/lib/game/attempt";
import {
  isRoundExhausted,
  isValidChapterId,
  pointsForCorrectGuess,
  potentialPoints,
  triesRemaining,
} from "@/lib/game/rules";
import { badRequest, conflict, toErrorResponse, unavailable } from "@/lib/http/api-error";
import { enforceRateLimit, rateLimitIdentities } from "@/lib/http/rate-limit";
import { rateLimits } from "@/lib/config/env";

export const dynamic = "force-dynamic";

const ROUTE = "api/game/guess";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token ?? "");
    const skip = body.skip === true;
    const skipRound = body.skipRound === true;
    const guessChapterId = Number(body.chapterId);

    if (!skip && !skipRound && !isValidChapterId(guessChapterId)) {
      throw badRequest("Choose a Surah before submitting.");
    }

    const round = openRound(token);

    // The token proves which round this is; the cookie proves it is this
    // browser's attempt. Requiring both stops a token lifted from one session
    // being replayed in another.
    const cookieAttemptId = request.cookies.get(ATTEMPT_COOKIE_NAME)?.value;
    if (!cookieAttemptId || cookieAttemptId !== round.attemptId) {
      throw conflict("This attempt session is no longer valid. Reload SurahSpot to start again.");
    }

    const limits = rateLimits();
    if (limits.enabled) {
      await enforceRateLimit("action", rateLimitIdentities(request, cookieAttemptId), limits.actionPerMinute);
    }

    const catalog = await getCatalog();
    const answer = findChapter(catalog, round.chapterId);
    if (!answer) throw unavailable("Could not resolve the Surah answer right now.");

    const reveal = {
      verseKey: round.verseKey,
      chapterId: answer.id,
      nameSimple: answer.name_simple,
      nameArabic: answer.name_arabic,
      translatedName: answer.translated_name?.name ?? "",
    };

    // Everything that changes state happens inside one locked, persisted
    // mutation, so a hint and a guess arriving together cannot both consume the
    // same round revision.
    const payload = await mutateAttempt(cookieAttemptId, (attempt) => {
      // Consuming the current revision is what makes a saved pre-hint token
      // useless for rolling back the 3-point second-hint cost.
      assertRoundActive(attempt, round.roundId, round.revision);

      // Double-forward skip: end the whole round immediately at 0 points.
      if (skipRound) {
        finishRound(attempt, round.roundId, round.revision);
        return {
          correct: false,
          exhausted: true,
          skippedRound: true,
          points: 0,
          pointsRemaining: 0,
          attemptsRemaining: 0,
          reveal,
          progress: attemptProgress(attempt),
        };
      }

      const correct = !skip && guessChapterId === round.chapterId;
      if (correct) {
        const points = pointsForCorrectGuess(round.attemptsUsed, round.hintPenalty);
        finishRound(attempt, round.roundId, round.revision);
        return {
          correct: true,
          points,
          attemptsRemaining: triesRemaining(round.attemptsUsed),
          reveal,
          progress: attemptProgress(attempt),
        };
      }

      const attemptsUsed = round.attemptsUsed + 1;
      if (isRoundExhausted(attemptsUsed)) {
        finishRound(attempt, round.roundId, round.revision);
        return {
          correct: false,
          exhausted: true,
          points: 0,
          pointsRemaining: 0,
          attemptsRemaining: 0,
          reveal,
          progress: attemptProgress(attempt),
        };
      }

      const nextRevision = rotateRoundRevision(attempt, round.roundId, round.revision);
      return {
        correct: false,
        exhausted: false,
        // A fresh token at the new revision. The previous one is now stale.
        token: sealRound({ ...round, attemptsUsed, revision: nextRevision }),
        pointsRemaining: potentialPoints(attemptsUsed, round.hintPenalty),
        attemptsRemaining: triesRemaining(attemptsUsed),
        progress: attemptProgress(attempt),
      };
    });

    return NextResponse.json(payload);
  } catch (error) {
    return toErrorResponse(error, ROUTE);
  }
}
