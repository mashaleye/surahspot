export const REQUESTED_LANGUAGES = [
  "english", "afar", "albanian", "amazigh", "amharic", "arabic", "asante", "assamese", "azeri",
  "bambara", "bengali", "bosnian", "bulgarian", "central khmer", "chechen", "chinese", "croatian",
  "czech", "dari", "divehi", "dutch", "filipino", "finnish", "french", "ganda", "german", "gujarati",
  "hausa", "hebrew", "hindi", "indonesian", "italian", "japanese", "kannada", "kazakh", "khmer",
  "kinyarwanda", "korean", "kurdish", "kyrgyz, kirghiz", "lingala", "lithuanian", "macedonian", "malay",
  "malayalam", "maranao", "marathi", "moore", "nepali", "norwegian", "oromo", "pashto", "persian",
  "polish", "portuguese", "punjabi", "romanian", "rundi", "russian", "serbian", "sindhi",
  "sinhala, sinhalese", "somali", "spanish", "swahili", "swedish", "tagalog", "tajik", "tamil", "tatar",
  "telugu", "thai", "turkish", "uighur, uyghur", "ukrainian", "urdu", "uzbek", "vietnamese", "yau,yuw",
  "yoruba"
] as const;

const ALIASES: Record<string, string[]> = {
  amazigh: ["amazigh", "tamazight", "berber"],
  asante: ["asante", "twi", "akan"],
  azeri: ["azeri", "azerbaijani"],
  "central khmer": ["central khmer", "khmer"],
  filipino: ["filipino", "tagalog"],
  chinese: ["chinese", "chinese simplified", "chinese traditional", "mandarin"],
  ganda: ["ganda", "luganda"],
  oromo: ["oromo", "oromoo"],
  persian: ["persian", "farsi"],
  rundi: ["rundi", "kirundi"],
  swahili: ["swahili", "kiswahili"],
  khmer: ["khmer", "central khmer"],
  "kyrgyz, kirghiz": ["kyrgyz", "kirghiz"],
  moore: ["moore", "mooré", "mossi"],
  "sinhala, sinhalese": ["sinhala", "sinhalese"],
  tagalog: ["tagalog", "filipino"],
  "uighur, uyghur": ["uighur", "uyghur"],
  "yau,yuw": ["yau", "yuw"],
};

export function normalizeLanguage(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

export function languageMatches(requested: string, apiLanguage: string) {
  const target = normalizeLanguage(apiLanguage);
  const candidates = ALIASES[requested] ?? [requested];
  return candidates.some((candidate) => normalizeLanguage(candidate) === target);
}

export function prettyLanguage(language: string) {
  return language.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
