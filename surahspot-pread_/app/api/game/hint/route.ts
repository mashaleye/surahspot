import { NextRequest, NextResponse } from "next/server";
import { type Chapter, findChapter, getCatalog } from "@/lib/quran/catalog";
import { openRound, sealRound } from "@/lib/quran/round-token";
import { juzForVerseKey } from "@/lib/quran/juz";
import { ATTEMPT_COOKIE_NAME, mutateAttempt } from "@/lib/game/attempt-service";
import { attemptProgress, consumeHint } from "@/lib/game/attempt";
import { type HintType, isHintType, potentialPoints } from "@/lib/game/rules";
import { badRequest, conflict, toErrorResponse, unavailable } from "@/lib/http/api-error";
import { enforceRateLimit, rateLimitIdentities } from "@/lib/http/rate-limit";
import { rateLimits } from "@/lib/config/env";

export const dynamic = "force-dynamic";

const ROUTE = "api/game/hint";

export type HintReveal = { type: HintType; label: string; value: string };

/**
 * Build the one fact the player paid for.
 *
 * Every branch returns a single derived string and never a chapter id, name, or
 * verse key — the identifiers that would give the answer away. This is why the
 * hint is composed on the server from the sealed round rather than the client
 * being sent chapter metadata and choosing what to display.
 */
function buildHint(type: HintType, chapter: Chapter, verseKey: string): HintReveal {
  switch (type) {
    case "meaning": {
      const value = chapter.translated_name?.name?.trim();
      if (!value) throw unavailable("The Surah-name meaning is unavailable for this round.");
      return { type, label: "Meaning of the Surah name", value };
    }
    case "ayah_count":
      return { type, label: "Number of Ayahs", value: `${chapter.verses_count} Ayahs` };
    case "juz": {
      // Reports the Juz of this specific Ayah, not every Juz the Surah spans.
      const juz = juzForVerseKey(verseKey);
      if (!juz) throw unavailable("The Juz could not be resolved for this Ayah.");
      return { type, label: "Juz / place in the Qur'an", value: `This Ayah is in Juz ${juz}` };
    }
    case "revelation_place": {
      const place = chapter.revelation_place?.trim().toLowerCase();
      if (place === "makkah" || place === "mecca") {
        return { type, label: "Makkah or Madinah", value: "Makki \u00b7 revealed in Makkah" };
      }
      if (place === "madinah" || place === "medina") {
        return { type, label: "Makkah or Madinah", value: "Madani \u00b7 revealed in Madinah" };
      }
      throw unavailable("The revelation place is unavailable for this round.");
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token ?? "");
    const type = body.type;

    // An unknown hint type is rejected before anything touches the answer, so a
    // probe like {"type":"chapterId"} gets a flat 400 and learns nothing.
    if (!isHintType(type)) {
      throw badRequest("Choose one of the available hint types.");
    }

    const round = openRound(token);
    const cookieAttemptId = request.cookies.get(ATTEMPT_COOKIE_NAME)?.value;
    if (!cookieAttemptId || cookieAttemptId !== round.attemptId) {
      throw conflict("This attempt session is no longer valid. Reload SurahSpot to start again.");
    }

    const limits = rateLimits();
    if (limits.enabled) {
      await enforceRateLimit("action", rateLimitIdentities(request, cookieAttemptId), limits.actionPerMinute);
    }

    const catalog = await getCatalog();
    const chapter = findChapter(catalog, round.chapterId);
    if (!chapter) throw unavailable("Could not resolve hint metadata for this round.");

    // Resolved before the lock so a missing-metadata failure does not spend the
    // player's hint allowance, but after the token check so it cannot be used
    // to probe for chapter data without a valid round.
    const hint = buildHint(type, chapter, round.verseKey);

    const payload = await mutateAttempt(cookieAttemptId, (attempt) => {
      // Serialized per attempt: two simultaneous requests cannot both observe
      // "one hint left" and both spend it.
      const usage = consumeHint(attempt, round.roundId, round.revision, type);
      const hintPenalty = round.hintPenalty + usage.cost;

      return {
        hint,
        // Rotating the revision is what invalidates a token saved before the
        // paid hint, which would otherwise be replayed to dodge the deduction.
        token: sealRound({ ...round, hintPenalty, revision: usage.revision }),
        cost: usage.cost,
        hintsUsed: usage.hintsUsed,
        hintsRemaining: usage.hintsRemaining,
        nextHintCost: usage.nextHintCost,
        pointsRemaining: potentialPoints(round.attemptsUsed, hintPenalty),
        progress: attemptProgress(attempt),
      };
    });

    const response = NextResponse.json(payload);
    response.headers.set("Cache-Control", "no-store, private");
    return response;
  } catch (error) {
    return toErrorResponse(error, ROUTE);
  }
}
