#!/usr/bin/env node
/**
 * Vendor the Uthmanic Hafs font into public/fonts.
 *
 * SurahSpot self-hosts the Quranic face rather than fetching it cross-origin.
 * The cross-origin arrangement had a failure mode worth avoiding: the
 * stylesheet's origin and the CSP `font-src` had to agree, and when they
 * drifted the font was blocked, the Arabic silently fell back to a system face,
 * and nothing errored. That is a rendering regression on the most important
 * text in the app, invisible to every automated check.
 *
 * Self-hosting removes the CSP exception entirely, removes a render-blocking
 * request to a host we do not control, and makes a missing font a build
 * failure instead of a silent downgrade.
 *
 *   node scripts/fetch-font.mjs            # download if absent
 *   node scripts/fetch-font.mjs --check    # verify only, exit 1 if missing
 *   node scripts/fetch-font.mjs --force    # re-download
 *
 * Licensing: the KFGQPC Uthmanic Hafs face is published by the King Fahd
 * Glorious Quran Printing Complex for Quranic use. It is fetched at setup time
 * rather than committed, so the licence terms travel with the source you
 * obtain it from. Review them before redistributing this repository with the
 * binary included.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const fontDirectory = join(projectRoot, "public", "fonts");

const FONT = {
  file: "UthmanicHafs1Ver18.ttf",
  url:
    process.env.QURAN_FONT_URL ??
    "https://verses.quran.foundation/fonts/quran/hafs/uthmanic_hafs/UthmanicHafs1Ver18.ttf",
  // A truncated or error-page download is the failure this guards against: an
  // HTML 404 body written to a .ttf path would be served happily and render as
  // nothing. Size and magic bytes together catch that.
  minimumBytes: 200_000,
};

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const force = args.has("--force");

const target = join(fontDirectory, FONT.file);

/** TrueType files start with 0x00010000, or "true"/"ttcf" for variants. */
function looksLikeTrueType(buffer) {
  if (buffer.length < 4) return false;
  const signature = buffer.readUInt32BE(0);
  return (
    signature === 0x00010000 ||
    buffer.subarray(0, 4).toString("latin1") === "true" ||
    buffer.subarray(0, 4).toString("latin1") === "ttcf" ||
    buffer.subarray(0, 4).toString("latin1") === "OTTO"
  );
}

async function verify() {
  let info;
  try {
    info = await stat(target);
  } catch {
    return { ok: false, reason: `missing (${target})` };
  }

  if (info.size < FONT.minimumBytes) {
    return { ok: false, reason: `too small (${info.size} bytes) — likely a truncated download` };
  }

  const head = (await readFile(target)).subarray(0, 4);
  if (!looksLikeTrueType(head)) {
    return { ok: false, reason: "not a TrueType file — the download probably returned an error page" };
  }

  return { ok: true, bytes: info.size };
}

async function download() {
  console.info(`Downloading ${FONT.file} from ${FONT.url}`);

  const response = await fetch(FONT.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Font download failed with HTTP ${response.status}.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length < FONT.minimumBytes) {
    throw new Error(`Downloaded only ${buffer.length} bytes; expected at least ${FONT.minimumBytes}.`);
  }
  if (!looksLikeTrueType(buffer)) {
    throw new Error("Downloaded file is not a TrueType font. Check QURAN_FONT_URL.");
  }

  await mkdir(fontDirectory, { recursive: true });
  await writeFile(target, buffer);
  console.info(`Wrote ${target} (${(buffer.length / 1024).toFixed(0)} KB)`);
}

const existing = await verify();

if (checkOnly) {
  if (existing.ok) {
    console.info(`Font present: ${FONT.file} (${(existing.bytes / 1024).toFixed(0)} KB)`);
    process.exit(0);
  }
  console.error(
    `\nQuranic font is ${existing.reason}.\n\n` +
      "The app self-hosts this face and its CSP does not permit a cross-origin\n" +
      "fallback, so building without it would ship Arabic rendered in a system\n" +
      "font. Fetch it with:\n\n  npm run fetch:font\n",
  );
  process.exit(1);
}

if (existing.ok && !force) {
  console.info(`Font already present: ${FONT.file} (${(existing.bytes / 1024).toFixed(0)} KB)`);
  process.exit(0);
}

try {
  await download();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  console.error(
    "If this machine has no access to the font host, download\n" +
      `${FONT.file} manually and place it at:\n  ${target}\n`,
  );
  process.exit(1);
}
