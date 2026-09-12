/**
 * Strip Quran Foundation's inline markup from translation and transliteration
 * text before it is rendered.
 *
 * The text goes into React as a string, so this is not an XSS boundary — React
 * escapes it either way. It is a presentation fix: QF returns footnote markers,
 * <sup> references and <br> tags inline, which render as literal noise.
 *
 * Tags are replaced with a space rather than removed. Removing them fused
 * adjacent spans together, so "the Cow" arrived as "theCow" whenever the
 * resource wrapped a word in markup.
 */
export function cleanTranslationHtml(input: string) {
  if (!input) return "";
  return input
    // Footnote superscripts carry no meaning once the footnote itself is gone.
    .replace(/<sup[^>]*>.*?<\/sup>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a Surah search term for local matching.
 *
 * Shared with the client so "Al-Baqarah", "al baqarah", "Baqarah" and
 * "surah baqarah" all reach the same entry whether the match happens in the
 * browser or against the local catalog on the server.
 */
export function normalizeSurahQuery(value: string | null | undefined) {
  // Catalog fields are optional upstream: a chapter record with no
  // name_complex used to crash local search with a TypeError, which the route
  // then reported as a 500 for every fallback query.
  if (!value) return "";
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^surah\s+/, "")
    .replace(/[\u2019'`._-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
