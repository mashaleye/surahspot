/**
 * Report what the configured Quran Foundation environment actually contains.
 *
 *   node --env-file=.env.local scripts/probe-coverage.mjs
 *
 * SurahSpot needs three things to line up for a Surah to be playable:
 *   1. the chapter exists upstream
 *   2. /verses/by_chapter returns an Ayah for it
 *   3. some chapter reciter returns word-level segments for it
 *
 * Pre-live can be a reduced mock dataset, in which case most Surahs satisfy
 * none of these. This prints the real numbers instead of guessing.
 */
const ENVIRONMENTS = {
  prelive: { auth: "https://prelive-oauth2.quran.foundation", api: "https://apis-prelive.quran.foundation" },
  production: { auth: "https://oauth2.quran.foundation", api: "https://apis.quran.foundation" },
};

const clientId = process.env.QF_CLIENT_ID?.trim();
const clientSecret = process.env.QF_CLIENT_SECRET?.trim();
const envName = (process.env.QF_ENV ?? "prelive").trim().toLowerCase();
const config = ENVIRONMENTS[envName];

if (!clientId || !clientSecret) {
  console.error("Set QF_CLIENT_ID and QF_CLIENT_SECRET (try --env-file=.env.local).");
  process.exit(1);
}
if (!config) {
  console.error(`QF_ENV must be "prelive" or "production" (received "${process.env.QF_ENV}").`);
  process.exit(1);
}

const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
const tokenResponse = await fetch(`${config.auth}/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", scope: "content" }),
});
if (!tokenResponse.ok) {
  console.error(`Token request failed (${tokenResponse.status}): ${(await tokenResponse.text()).slice(0, 200)}`);
  process.exit(1);
}
const token = (await tokenResponse.json()).access_token;

async function api(path) {
  const response = await fetch(`${config.api}/content/api/v4${path}`, {
    headers: { "x-auth-token": token, "x-client-id": clientId, Accept: "application/json" },
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, data: await response.json() };
}

console.log(`environment: ${envName}  (${config.api})\n`);

const chaptersResult = await api("/chapters?language=en");
const chapters = chaptersResult.ok ? (chaptersResult.data.chapters ?? []) : [];
console.log(`/chapters            -> ${chapters.length} chapter(s)`);
if (chapters.length && chapters.length < 114) {
  console.log(`  ids present: ${chapters.map((c) => c.id).join(", ")}`);
  console.log("  NOTE: fewer than 114 means this environment is a reduced dataset.");
}

const recitersResult = await api("/resources/chapter_reciters?language=en");
const reciters = recitersResult.ok ? (recitersResult.data.reciters ?? []) : [];
console.log(`/chapter_reciters    -> ${reciters.length} reciter(s)\n`);

// Probe a spread: whatever a reduced environment reports, plus the Surahs that
// showed up in the original failure and a few well-known short ones. Capped so
// this stays cheap against a full 114-chapter environment.
const reported = chapters.length < 114 ? chapters.map((c) => c.id) : [];
const sample = [...new Set([...reported, 1, 2, 29, 36, 67, 112, 114])].sort((a, b) => a - b).slice(0, 12);

console.log("chapter  verses  timed-reciters (of first 10 probed)");
console.log("-------  ------  ----------------------------------");

let playable = 0;
for (const chapterId of sample) {
  const verse = await api(`/verses/by_chapter/${chapterId}?page=1&per_page=1&words=true`);
  const hasVerse = verse.ok && (verse.data.verses?.length ?? 0) > 0;

  const timed = [];
  for (const reciter of reciters.slice(0, 10)) {
    const audio = await api(`/chapter_recitations/${reciter.id}/${chapterId}?segments=true`);
    if (!audio.ok) continue;
    const timestamps = audio.data.audio_file?.timestamps ?? [];
    const withSegments = timestamps.filter((t) => Array.isArray(t.segments) && t.segments.length > 0);
    if (withSegments.length) timed.push(`${reciter.id}(${withSegments.length} ayat)`);
  }

  if (hasVerse && timed.length) playable += 1;
  const verseCell = hasVerse ? "yes" : (verse.status ? String(verse.status) : "no");
  console.log(`${String(chapterId).padStart(7)}  ${verseCell.padStart(6)}  ${timed.length ? timed.join(", ") : "none"}`);
}

console.log(`\nplayable in this sample: ${playable}/${sample.length}`);
console.log("A Surah is playable only when it has BOTH a verse and a reciter with segments.");
if (playable === 0) {
  console.log("\nNothing here is playable. The game needs production access, or a");
  console.log("different environment - no amount of retrying will produce a round.");
}
