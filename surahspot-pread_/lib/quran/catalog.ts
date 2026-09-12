import { languageMatches, REQUESTED_LANGUAGES } from "./languages";
import { qfFetch } from "./client";
import { normalizeSurahQuery } from "./text";

export type Chapter = {
  id: number;
  revelation_place: string;
  revelation_order: number;
  bismillah_pre: boolean;
  name_simple: string;
  name_complex: string;
  name_arabic: string;
  verses_count: number;
  translated_name?: { language_name: string; name: string };
};

export type TranslationResource = {
  id: number;
  name: string;
  author_name: string;
  slug: string;
  language_name: string;
};

export type ChapterReciter = {
  id: number;
  name: string;
  style?: { name?: string | null; language_name?: string };
  qirat?: { name?: string | null; language_name?: string };
};

// Keep a local canonical chapter index as a safety net. The Quran Foundation
// /chapters endpoint normally returns all 114 chapters, but the game should
// never become unplayable if a pre-live response, proxy, cache, or mock is
// incomplete. API metadata is still preferred whenever it is available.
const CANONICAL_CHAPTERS: ReadonlyArray<readonly [number, string, string, number]> = [
  [1, "Al-Fatihah", "الفاتحة", 7],
  [2, "Al-Baqarah", "البقرة", 286],
  [3, "Ali 'Imran", "آل عمران", 200],
  [4, "An-Nisa", "النساء", 176],
  [5, "Al-Ma'idah", "المائدة", 120],
  [6, "Al-An'am", "الأنعام", 165],
  [7, "Al-A'raf", "الأعراف", 206],
  [8, "Al-Anfal", "الأنفال", 75],
  [9, "At-Tawbah", "التوبة", 129],
  [10, "Yunus", "يونس", 109],
  [11, "Hud", "هود", 123],
  [12, "Yusuf", "يوسف", 111],
  [13, "Ar-Ra'd", "الرعد", 43],
  [14, "Ibrahim", "ابراهيم", 52],
  [15, "Al-Hijr", "الحجر", 99],
  [16, "An-Nahl", "النحل", 128],
  [17, "Al-Isra", "الإسراء", 111],
  [18, "Al-Kahf", "الكهف", 110],
  [19, "Maryam", "مريم", 98],
  [20, "Taha", "طه", 135],
  [21, "Al-Anbya", "الأنبياء", 112],
  [22, "Al-Hajj", "الحج", 78],
  [23, "Al-Mu'minun", "المؤمنون", 118],
  [24, "An-Nur", "النور", 64],
  [25, "Al-Furqan", "الفرقان", 77],
  [26, "Ash-Shu'ara", "الشعراء", 227],
  [27, "An-Naml", "النمل", 93],
  [28, "Al-Qasas", "القصص", 88],
  [29, "Al-'Ankabut", "العنكبوت", 69],
  [30, "Ar-Rum", "الروم", 60],
  [31, "Luqman", "لقمان", 34],
  [32, "As-Sajdah", "السجدة", 30],
  [33, "Al-Ahzab", "الأحزاب", 73],
  [34, "Saba", "سبإ", 54],
  [35, "Fatir", "فاطر", 45],
  [36, "Ya-Sin", "يس", 83],
  [37, "As-Saffat", "الصافات", 182],
  [38, "Sad", "ص", 88],
  [39, "Az-Zumar", "الزمر", 75],
  [40, "Ghafir", "غافر", 85],
  [41, "Fussilat", "فصلت", 54],
  [42, "Ash-Shuraa", "الشورى", 53],
  [43, "Az-Zukhruf", "الزخرف", 89],
  [44, "Ad-Dukhan", "الدخان", 59],
  [45, "Al-Jathiyah", "الجاثية", 37],
  [46, "Al-Ahqaf", "الأحقاف", 35],
  [47, "Muhammad", "محمد", 38],
  [48, "Al-Fath", "الفتح", 29],
  [49, "Al-Hujurat", "الحجرات", 18],
  [50, "Qaf", "ق", 45],
  [51, "Adh-Dhariyat", "الذاريات", 60],
  [52, "At-Tur", "الطور", 49],
  [53, "An-Najm", "النجم", 62],
  [54, "Al-Qamar", "القمر", 55],
  [55, "Ar-Rahman", "الرحمن", 78],
  [56, "Al-Waqi'ah", "الواقعة", 96],
  [57, "Al-Hadid", "الحديد", 29],
  [58, "Al-Mujadila", "المجادلة", 22],
  [59, "Al-Hashr", "الحشر", 24],
  [60, "Al-Mumtahanah", "الممتحنة", 13],
  [61, "As-Saf", "الصف", 14],
  [62, "Al-Jumu'ah", "الجمعة", 11],
  [63, "Al-Munafiqun", "المنافقون", 11],
  [64, "At-Taghabun", "التغابن", 18],
  [65, "At-Talaq", "الطلاق", 12],
  [66, "At-Tahrim", "التحريم", 12],
  [67, "Al-Mulk", "الملك", 30],
  [68, "Al-Qalam", "القلم", 52],
  [69, "Al-Haqqah", "الحاقة", 52],
  [70, "Al-Ma'arij", "المعارج", 44],
  [71, "Nuh", "نوح", 28],
  [72, "Al-Jinn", "الجن", 28],
  [73, "Al-Muzzammil", "المزمل", 20],
  [74, "Al-Muddaththir", "المدثر", 56],
  [75, "Al-Qiyamah", "القيامة", 40],
  [76, "Al-Insan", "الانسان", 31],
  [77, "Al-Mursalat", "المرسلات", 50],
  [78, "An-Naba", "النبإ", 40],
  [79, "An-Nazi'at", "النازعات", 46],
  [80, "'Abasa", "عبس", 42],
  [81, "At-Takwir", "التكوير", 29],
  [82, "Al-Infitar", "الإنفطار", 19],
  [83, "Al-Mutaffifin", "المطففين", 36],
  [84, "Al-Inshiqaq", "الإنشقاق", 25],
  [85, "Al-Buruj", "البروج", 22],
  [86, "At-Tariq", "الطارق", 17],
  [87, "Al-A'la", "الأعلى", 19],
  [88, "Al-Ghashiyah", "الغاشية", 26],
  [89, "Al-Fajr", "الفجر", 30],
  [90, "Al-Balad", "البلد", 20],
  [91, "Ash-Shams", "الشمس", 15],
  [92, "Al-Layl", "الليل", 21],
  [93, "Ad-Duhaa", "الضحى", 11],
  [94, "Ash-Sharh", "الشرح", 8],
  [95, "At-Tin", "التين", 8],
  [96, "Al-'Alaq", "العلق", 19],
  [97, "Al-Qadr", "القدر", 5],
  [98, "Al-Bayyinah", "البينة", 8],
  [99, "Az-Zalzalah", "الزلزلة", 8],
  [100, "Al-'Adiyat", "العاديات", 11],
  [101, "Al-Qari'ah", "القارعة", 11],
  [102, "At-Takathur", "التكاثر", 8],
  [103, "Al-'Asr", "العصر", 3],
  [104, "Al-Humazah", "الهمزة", 9],
  [105, "Al-Fil", "الفيل", 5],
  [106, "Quraysh", "قريش", 4],
  [107, "Al-Ma'un", "الماعون", 7],
  [108, "Al-Kawthar", "الكوثر", 3],
  [109, "Al-Kafirun", "الكافرون", 6],
  [110, "An-Nasr", "النصر", 3],
  [111, "Al-Masad", "المسد", 5],
  [112, "Al-Ikhlas", "الإخلاص", 4],
  [113, "Al-Falaq", "الفلق", 5],
  [114, "An-Nas", "الناس", 6],
];

function completeChapterCatalog(chapters: Chapter[]) {
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));

  return CANONICAL_CHAPTERS.map(([id, nameSimple, nameArabic, versesCount]) => {
    const upstream = byId.get(id);
    if (upstream) return upstream;

    return {
      id,
      revelation_place: "",
      revelation_order: 0,
      bismillah_pre: id !== 9,
      name_simple: nameSimple,
      name_complex: nameSimple,
      name_arabic: nameArabic,
      verses_count: versesCount,
      translated_name: undefined,
    } satisfies Chapter;
  });
}

export type Catalog = {
  fetchedAt: number;
  expires: number;
  chapters: Chapter[];
  // Chapter ids the environment actually serves. The canonical 114 are padded
  // in so the answer picker stays complete, but a Surah upstream does not have
  // cannot build a round.
  upstreamChapterIds: Set<number>;
  translations: TranslationResource[];
  reciters: ChapterReciter[];
};

type CatalogGlobals = typeof globalThis & {
  __surahspotCatalog?: Catalog | null;
  __surahspotCatalogInflight?: Promise<Catalog> | null;
};

const catalogGlobals = globalThis as CatalogGlobals;

const CATALOG_TTL_MS = 15 * 60_000;
// How long an expired catalog may still be served if a refresh fails. Chapter
// names, reciters and translation resources change on the order of months, so
// a stale catalog is enormously better than a dead app during an upstream blip.
const CATALOG_STALE_GRACE_MS = 6 * 60 * 60_000;

async function fetchCatalog(): Promise<Catalog> {
  const [chaptersData, translationsData, recitersData] = await Promise.all([
    qfFetch<{ chapters: Chapter[] }>("/chapters?language=en"),
    qfFetch<{ translations: TranslationResource[] }>("/resources/translations?language=en"),
    qfFetch<{ reciters: ChapterReciter[] }>("/resources/chapter_reciters?language=en"),
  ]);

  const now = Date.now();
  return {
    fetchedAt: now,
    expires: now + CATALOG_TTL_MS,
    chapters: completeChapterCatalog(chaptersData.chapters ?? []),
    upstreamChapterIds: new Set(
      (chaptersData.chapters ?? [])
        .map((chapter) => Number(chapter?.id))
        .filter((id) => Number.isInteger(id) && id >= 1 && id <= 114),
    ),
    translations: translationsData.translations ?? [],
    reciters: recitersData.reciters ?? [],
  };
}

/**
 * Chapters, translation resources and chapter reciters, cached per process.
 *
 * Three behaviours matter in production and none of them were here before:
 *
 * - Concurrent callers share one refresh. A cold start under load previously
 *   issued three upstream calls per in-flight request.
 * - A failed refresh falls back to the last good catalog for a grace period,
 *   so a brief upstream outage degrades rather than breaks the game.
 * - The cache hangs off globalThis so a dev-server hot reload does not discard
 *   it and re-fetch on the next keystroke.
 */
export async function getCatalog(): Promise<Catalog> {
  const cached = catalogGlobals.__surahspotCatalog;
  if (cached && cached.expires > Date.now()) return cached;

  const inflight = catalogGlobals.__surahspotCatalogInflight;
  if (inflight) return inflight;

  const pending = fetchCatalog()
    .then((catalog) => {
      catalogGlobals.__surahspotCatalog = catalog;
      return catalog;
    })
    .catch((error) => {
      const stale = catalogGlobals.__surahspotCatalog;
      if (stale && Date.now() - stale.fetchedAt < CATALOG_STALE_GRACE_MS) {
        console.warn("[catalog] refresh failed, serving stale catalog", error);
        // Back off before the next attempt so a hard outage is not hammered.
        stale.expires = Date.now() + 60_000;
        return stale;
      }
      throw error;
    })
    .finally(() => { catalogGlobals.__surahspotCatalogInflight = null; });

  catalogGlobals.__surahspotCatalogInflight = pending;
  return pending;
}

/** Test seam: drop the cached catalog. */
export function resetCatalogCache() {
  catalogGlobals.__surahspotCatalog = null;
  catalogGlobals.__surahspotCatalogInflight = null;
}

export function chooseTranslation(translations: TranslationResource[], language: string) {
  const matches = translations.filter((translation) => languageMatches(language, translation.language_name));
  if (!matches.length) return null;
  if (language === "english") {
    return matches.find((item) => item.id === 131) ?? matches.find((item) => /clear quran/i.test(item.name)) ?? matches[0];
  }
  return matches[0];
}

export function chooseReciter(reciters: ChapterReciter[], preferredId?: number) {
  if (preferredId) {
    const selected = reciters.find((reciter) => reciter.id === preferredId);
    if (selected) return selected;
  }
  return reciters.find((reciter) => /afasy|alafasy/i.test(reciter.name)) ?? reciters[0];
}

export function languageCatalog(translations: TranslationResource[]) {
  return REQUESTED_LANGUAGES.map((language) => {
    const resource = chooseTranslation(translations, language);
    return {
      id: language,
      label: language,
      available: Boolean(resource),
      translationId: resource?.id ?? null,
      translationName: resource?.name ?? null,
      authorName: resource?.author_name ?? null,
    };
  });
}

/** Lookup by chapter id. Used by every route that resolves a sealed answer. */
export function findChapter(catalog: Catalog, chapterId: number) {
  return catalog.chapters.find((chapter) => chapter.id === chapterId) ?? null;
}

/**
 * Offline Surah matching against the canonical catalog.
 *
 * The search route calls Quran Foundation Quick Search first, but that is a
 * network dependency sitting in front of the one control a player must always
 * have: choosing an answer. If Search is down, or rate-limited, or the `search`
 * scope was never granted, this keeps the answer picker fully usable.
 */
export function searchChaptersLocally(catalog: Catalog, query: string, limit = 25) {
  const normalized = normalizeSurahQuery(query);
  if (!normalized) return [];

  const scored = catalog.chapters.flatMap((chapter) => {
    const aliases = [
      chapter.name_simple,
      chapter.name_complex,
      chapter.translated_name?.name ?? "",
      String(chapter.id),
    ].map(normalizeSurahQuery);

    // Arabic is compared unnormalized: the Latin-oriented normalizer strips
    // the diacritics that distinguish Arabic Surah names from one another.
    const arabicMatch = chapter.name_arabic?.includes(query.trim());

    let score = -1;
    for (const alias of aliases) {
      if (!alias) continue;
      if (alias === normalized) { score = Math.max(score, 3); continue; }
      if (alias.startsWith(normalized)) { score = Math.max(score, 2); continue; }
      if (alias.includes(normalized)) score = Math.max(score, 1);
    }
    if (arabicMatch) score = Math.max(score, 2);

    return score >= 0 ? [{ chapter, score }] : [];
  });

  return scored
    .sort((a, b) => b.score - a.score || a.chapter.id - b.chapter.id)
    .slice(0, limit)
    .map((entry) => entry.chapter);
}
