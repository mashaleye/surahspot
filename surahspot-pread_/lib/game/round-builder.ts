import { randomInt } from "node:crypto";
import { isRecoverableUpstream, qfFetch } from "@/lib/quran/client";
import { type Catalog, type ChapterReciter, chooseReciter, chooseTranslation } from "@/lib/quran/catalog";
import { hasUsableTiming, normalizeSegments, type Segment } from "@/lib/quran/karaoke";
import { cleanTranslationHtml } from "@/lib/quran/text";
import { unavailable } from "@/lib/http/api-error";

/**
 * Chooses what a round is made of: which Surah, which Ayah, which recitation.
 *
 * Lifted out of the route handler so the selection rules can be tested against
 * the fixture upstream without going through HTTP, cookies, or token sealing.
 * The route is now transport — parse, authorize, call this, serialize — and
 * this module is the game logic.
 *
 * The selection order is the part worth protecting. Surah is drawn first and
 * uniformly, then an Ayah within it. Drawing an Ayah from the whole Quran
 * instead would make Al-Baqarah roughly 95 times likelier than Al-Kawthar,
 * which is a different (and much worse) game.
 */

type Word = {
  id?: number;
  position: number;
  text_uthmani?: string;
  char_type_name?: string;
};

type ApiVerse = {
  id: number;
  chapter_id: number;
  verse_number: number;
  verse_key: string;
  text_uthmani?: string;
  words?: Word[];
  translations?: Array<{ resource_id: number; text: string; language_name?: string; resource_name?: string }>;
};

type Timestamp = {
  verse_key: string;
  timestamp_from: number;
  timestamp_to: number;
  duration: number;
  segments?: unknown;
};

type ChapterAudioFile = {
  id: number;
  chapter_id: number;
  file_size?: number;
  format?: string;
  audio_url: string;
  timestamps?: Timestamp[] | null;
};

export type TimedVerse = {
  timestampFrom: number;
  timestampTo: number;
  segments: Segment[];
};

export type TimedChapter = {
  reciter: ChapterReciter;
  audioUrl: string;
  /** Ayah number -> playable timing. Only Ayahs with usable segments are kept. */
  verses: Map<number, TimedVerse>;
};

// A reciter's timing for a chapter is stable, so it is worth caching. Misses
// are cached for less time in case a flaky environment recovers.
const TIMED_CHAPTER_CACHE_MS = 15 * 60_000;
const TIMED_CHAPTER_MISS_CACHE_MS = 5 * 60_000;
const RECITER_RANK_CACHE_MS = 10 * 60_000;
const MAX_CHAPTER_ATTEMPTS = 4;
const MAX_VERSE_ATTEMPTS = 3;
const RECITER_PROBE_BATCH = 5;
/** Transliteration resource id, per the QF API documentation. */
const TRANSLITERATION_RESOURCE_ID = 57;

type BuilderGlobals = typeof globalThis & {
  __surahspotTimedChapters?: Map<string, { expiresAt: number; value: TimedChapter | null }>;
  __surahspotRecitersTimed?: Map<number, number>;
  __surahspotRecitersUntimed?: Map<number, number>;
};

const builderGlobals = globalThis as BuilderGlobals;
const timedChapterCache = builderGlobals.__surahspotTimedChapters ??= new Map();
const recitersSeenTimed = builderGlobals.__surahspotRecitersTimed ??= new Map();
const recitersSeenUntimed = builderGlobals.__surahspotRecitersUntimed ??= new Map();

export function resetRoundBuilderCaches() {
  timedChapterCache.clear();
  recitersSeenTimed.clear();
  recitersSeenUntimed.clear();
}

export function sanitizeExcludedChapters(value: unknown): Set<number> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .map(Number)
      .filter((id) => Number.isInteger(id) && id >= 1 && id <= 114),
  );
}

function buildChapterVersePath(chapterId: number, verseNumber: number, translationIds: string) {
  // QF pre-live has intermittently returned 500s for /verses/random when
  // chapter_number is supplied. The documented by_chapter endpoint with
  // per_page=1 makes page N map to Ayah N while preserving uniform verse
  // selection inside the already-uniformly-selected Surah.
  const params = new URLSearchParams({
    page: String(verseNumber),
    per_page: "1",
    words: "true",
    fields: "chapter_id,text_uthmani",
    word_fields: "text_uthmani,location",
    translations: translationIds,
    translation_fields: "resource_name,language_name",
  });
  return `/verses/by_chapter/${chapterId}?${params.toString()}`;
}

function orderReciters(reciters: ChapterReciter[], preferredId?: number) {
  if (!preferredId) return reciters;
  const preferred = reciters.find((reciter) => reciter.id === preferredId);
  if (!preferred) return reciters;
  return [preferred, ...reciters.filter((reciter) => reciter.id !== preferredId)];
}

function isFresh(store: Map<number, number>, reciterId: number) {
  const expiresAt = store.get(reciterId);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    store.delete(reciterId);
    return false;
  }
  return true;
}

function noteReciterOutcome(reciterId: number, hadSegments: boolean) {
  (hadSegments ? recitersSeenTimed : recitersSeenUntimed).set(reciterId, Date.now() + RECITER_RANK_CACHE_MS);
}

/**
 * 0 = known to publish segments, 1 = not seen yet, 2 = recently returned none.
 *
 * This only reorders the probe queue. Every reciter stays reachable, because a
 * reciter missing segments for one Surah can still have them for another —
 * excluding on one failure would permanently shrink the reciter pool.
 */
function reciterRank(reciterId: number) {
  if (isFresh(recitersSeenTimed, reciterId)) return 0;
  if (isFresh(recitersSeenUntimed, reciterId)) return 2;
  return 1;
}

function verseNumberFromTimestamp(verseKey: string, chapterId: number) {
  const [chapterPart, versePart] = String(verseKey).split(":");
  if (Number(chapterPart) !== chapterId) return null;
  const verseNumber = Number(versePart);
  return Number.isInteger(verseNumber) && verseNumber >= 1 ? verseNumber : null;
}

/**
 * Ask one chapter reciter for a chapter's timed audio.
 *
 * Returns null when the reciter has no audio for the chapter, or has audio but
 * no word-level segments. Both outcomes are cached so a Surah is probed once
 * rather than once per Ayah attempt.
 */
export async function fetchTimedChapter(reciter: ChapterReciter, chapterId: number): Promise<TimedChapter | null> {
  const cacheKey = `${reciter.id}:${chapterId}`;
  const cached = timedChapterCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const remember = (value: TimedChapter | null) => {
    timedChapterCache.set(cacheKey, {
      expiresAt: Date.now() + (value ? TIMED_CHAPTER_CACHE_MS : TIMED_CHAPTER_MISS_CACHE_MS),
      value,
    });
    return value;
  };

  let audioFile: ChapterAudioFile;
  try {
    // The single-chapter endpoint already 404s when this reciter does not cover
    // the chapter, so the full per-reciter chapter listing is not needed.
    const data = await qfFetch<{ audio_file: ChapterAudioFile }>(
      `/chapter_recitations/${reciter.id}/${chapterId}?segments=true`,
    );
    audioFile = data.audio_file;
  } catch (error) {
    if (isRecoverableUpstream(error)) return remember(null);
    throw error;
  }

  if (!audioFile?.audio_url) return remember(null);

  const timestamps = Array.isArray(audioFile.timestamps) ? audioFile.timestamps : [];
  if (!timestamps.length) {
    noteReciterOutcome(reciter.id, false);
    return remember(null);
  }

  const verses = new Map<number, TimedVerse>();
  for (const timestamp of timestamps) {
    const verseNumber = verseNumberFromTimestamp(timestamp?.verse_key ?? "", chapterId);
    if (verseNumber === null) continue;
    const segments = normalizeSegments(timestamp.segments);
    if (!hasUsableTiming(segments, timestamp.timestamp_from, timestamp.timestamp_to)) continue;
    verses.set(verseNumber, {
      timestampFrom: timestamp.timestamp_from,
      timestampTo: timestamp.timestamp_to,
      segments,
    });
  }

  if (!verses.size) {
    noteReciterOutcome(reciter.id, false);
    return remember(null);
  }

  noteReciterOutcome(reciter.id, true);
  return remember({ reciter, audioUrl: audioFile.audio_url, verses });
}

/**
 * Find a chapter reciter that can play this Surah with word-level timing.
 *
 * The player's saved reciter is tried alone first so the preference is honoured
 * whenever usable. The rest are probed in small concurrent batches — serially
 * this could mean dozens of sequential round trips before a round appears.
 */
export async function resolveTimedChapter(
  reciters: ChapterReciter[],
  preferredReciterId: number | undefined,
  chapterId: number,
): Promise<TimedChapter | null> {
  const ordered = orderReciters(reciters, preferredReciterId);
  if (!ordered.length) return null;

  const [preferred, ...rest] = ordered;
  const preferredMatch = await fetchTimedChapter(preferred, chapterId);
  if (preferredMatch) return preferredMatch;

  const candidates = rest
    .map((reciter, index) => ({ reciter, index, rank: reciterRank(reciter.id) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.reciter);

  for (let start = 0; start < candidates.length; start += RECITER_PROBE_BATCH) {
    const batch = candidates.slice(start, start + RECITER_PROBE_BATCH);
    const results = await Promise.all(batch.map(async (reciter) => {
      try {
        return await fetchTimedChapter(reciter, chapterId);
      } catch (error) {
        if (isRecoverableUpstream(error)) return null;
        throw error;
      }
    }));
    const match = results.find((result) => result !== null);
    if (match) return match;
  }

  return null;
}

function takeRandom<T>(pool: T[]): T {
  return pool.splice(randomInt(pool.length), 1)[0];
}

export type BuiltRound = {
  verseKey: string;
  chapterId: number;
  words: Array<{ index: number; position: number; arabic: string }>;
  arabic: string;
  transliteration: string;
  translation: string;
  translationMeta: { language: string; resourceId: number; name: string; author: string };
  audio: {
    fromMs: number;
    toMs: number;
    segments: Segment[];
    reciter: string;
    reciterId: number;
    requestedReciterId: number;
    usedFallbackReciter: boolean;
    url: string;
  };
};

export type BuildRoundOptions = {
  catalog: Catalog;
  language: string;
  preferredReciterId?: number;
  excludedChapterIds: Set<number>;
};

/**
 * Assemble one playable round, or throw if the environment cannot produce one.
 */
export async function buildRound({
  catalog,
  language,
  preferredReciterId,
  excludedChapterIds,
}: BuildRoundOptions): Promise<BuiltRound> {
  const translation =
    chooseTranslation(catalog.translations, language) ?? chooseTranslation(catalog.translations, "english");
  const preferredReciter = chooseReciter(catalog.reciters, preferredReciterId);
  if (!translation) throw unavailable("No translation resource is available right now.");
  if (!preferredReciter) throw unavailable("No chapter reciter is available right now.");

  // Only Surahs the environment actually serves can produce a round. On
  // production this is all 114 and the filter is a no-op; it protects against a
  // partial /chapters response and against reduced environments such as
  // pre-live, which serves only a subset.
  const served = catalog.upstreamChapterIds.size
    ? catalog.chapters.filter((chapter) => catalog.upstreamChapterIds.has(chapter.id))
    : catalog.chapters;
  const selectableChapters = served.length ? served : catalog.chapters;

  // Surahs already used in this attempt stay excluded, but if an environment
  // serves fewer Surahs than an attempt has rounds, repeat rather than fail.
  const availableChapters = selectableChapters.filter((chapter) => !excludedChapterIds.has(chapter.id));
  const chapterPool = (availableChapters.length ? availableChapters : selectableChapters).slice();
  if (!chapterPool.length) throw unavailable("No Surahs are available for this round.");

  const translationIds = Array.from(new Set([TRANSLITERATION_RESOURCE_ID, translation.id])).join(",");

  let verse: ApiVerse | null = null;
  let timedChapter: TimedChapter | null = null;
  let timedVerse: TimedVerse | null = null;
  let attemptedChapters = 0;

  // Sampling Surahs uniformly without replacement and keeping the first
  // playable one is still uniform across playable Surahs. A Surah no reciter
  // can time is skipped rather than failing the whole round.
  while (chapterPool.length && attemptedChapters < MAX_CHAPTER_ATTEMPTS && !verse) {
    attemptedChapters += 1;
    const chapter = takeRandom(chapterPool);

    const candidateChapter = await resolveTimedChapter(catalog.reciters, preferredReciter.id, chapter.id);
    if (!candidateChapter) continue;

    // The Ayah is drawn uniformly from the Ayahs this recitation can actually
    // highlight, so a round is never built on missing timing data.
    const verseNumbers = Array.from(candidateChapter.verses.keys());
    for (let tries = 0; tries < MAX_VERSE_ATTEMPTS && verseNumbers.length; tries += 1) {
      const verseNumber = takeRandom(verseNumbers);

      let verseData: { verses: ApiVerse[] };
      try {
        verseData = await qfFetch<{ verses: ApiVerse[] }>(
          buildChapterVersePath(chapter.id, verseNumber, translationIds),
        );
      } catch (error) {
        // Keep this inside the selected Surah and try another Ayah before
        // moving on, so a transient 5xx does not bias Surah selection.
        if (isRecoverableUpstream(error)) continue;
        throw error;
      }

      const candidate = verseData.verses?.[0];
      if (
        !candidate?.chapter_id ||
        !candidate.verse_key ||
        candidate.chapter_id !== chapter.id ||
        candidate.verse_number !== verseNumber
      ) {
        continue;
      }

      verse = candidate;
      timedChapter = candidateChapter;
      timedVerse = candidateChapter.verses.get(verseNumber)!;
      break;
    }
  }

  if (!verse || !timedChapter || !timedVerse) {
    throw unavailable(
      "No timed chapter recitation was available for the Surahs sampled for this round. Please retry — Surah selection stays balanced across the Surahs that have word-level timing.",
    );
  }

  const words = (verse.words ?? [])
    // The end-of-ayah marker is metadata, not a recited word, and including it
    // would offset every karaoke position by one at the end of the ayah.
    .filter((word) => word.text_uthmani && word.char_type_name !== "end")
    .map((word, index) => ({ index, position: word.position, arabic: word.text_uthmani! }));

  const transliteration = verse.translations?.find((item) => item.resource_id === TRANSLITERATION_RESOURCE_ID)?.text ?? "";
  const translated = verse.translations?.find((item) => item.resource_id === translation.id)?.text ?? "";

  return {
    verseKey: verse.verse_key,
    chapterId: verse.chapter_id,
    words,
    arabic: verse.text_uthmani ?? words.map((word) => word.arabic).join(" "),
    transliteration: cleanTranslationHtml(transliteration),
    translation: cleanTranslationHtml(translated),
    translationMeta: {
      language,
      resourceId: translation.id,
      name: translation.name,
      author: translation.author_name,
    },
    audio: {
      fromMs: timedVerse.timestampFrom,
      toMs: timedVerse.timestampTo,
      segments: timedVerse.segments,
      reciter: timedChapter.reciter.name,
      reciterId: timedChapter.reciter.id,
      requestedReciterId: preferredReciter.id,
      usedFallbackReciter: timedChapter.reciter.id !== preferredReciter.id,
      url: timedChapter.audioUrl,
    },
  };
}
