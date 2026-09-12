/**
 * Standard 30-Juz boundaries, as [chapter, verse] start points.
 *
 * Used by the Juz hint, which reports the Juz containing the specific Ayah
 * being recited rather than every Juz the Surah touches — a Surah like
 * Al-Baqarah spans three, so the Surah-level answer would be a weaker hint and
 * a less accurate one.
 */
export const JUZ_STARTS: ReadonlyArray<readonly [chapter: number, verse: number]> = [
  [1, 1], [2, 142], [2, 253], [3, 93], [4, 24], [4, 148], [5, 82], [6, 111],
  [7, 88], [8, 41], [9, 93], [11, 6], [12, 53], [15, 1], [17, 1], [18, 75],
  [21, 1], [23, 1], [25, 21], [27, 56], [29, 46], [33, 31], [36, 28], [39, 32],
  [41, 47], [46, 1], [51, 31], [58, 1], [67, 1], [78, 1],
];

export function parseVerseKey(verseKey: string): { chapter: number; verse: number } | null {
  const [chapterPart, versePart, ...rest] = String(verseKey).split(":");
  if (rest.length) return null;
  const chapter = Number(chapterPart);
  const verse = Number(versePart);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 114) return null;
  if (!Number.isInteger(verse) || verse < 1) return null;
  return { chapter, verse };
}

function compareVerse(aChapter: number, aVerse: number, bChapter: number, bVerse: number) {
  return aChapter === bChapter ? aVerse - bVerse : aChapter - bChapter;
}

/** Juz number (1–30) for a "chapter:verse" key, or null if the key is malformed. */
export function juzForVerseKey(verseKey: string): number | null {
  const parsed = parseVerseKey(verseKey);
  if (!parsed) return null;

  let juz = 1;
  for (let index = 0; index < JUZ_STARTS.length; index += 1) {
    const [startChapter, startVerse] = JUZ_STARTS[index];
    if (compareVerse(parsed.chapter, parsed.verse, startChapter, startVerse) >= 0) juz = index + 1;
    else break;
  }
  return juz;
}

/** Verse number from a key, for the reveal card. Null when malformed. */
export function verseNumberFromKey(verseKey: string, expectedChapterId?: number): number | null {
  const parsed = parseVerseKey(verseKey);
  if (!parsed) return null;
  if (expectedChapterId !== undefined && parsed.chapter !== expectedChapterId) return null;
  return parsed.verse;
}
