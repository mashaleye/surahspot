import crypto from "node:crypto";
import { roundTokenSecret } from "@/lib/config/env";

/**
 * The round token is the whole anti-cheat model in one object.
 *
 * It carries the answer (chapterId, verseKey), the audio URL the proxy will
 * fetch, the scoring state so far, and the attempt/round/revision triple that
 * ties it to server-side state. It is AES-256-GCM sealed, so the browser holds
 * an opaque blob it can neither read nor forge, and every mutation returns a
 * freshly sealed token at a new revision — which is what makes a saved
 * pre-hint token useless for dodging the second-hint cost.
 *
 * Kept separate from the HTTP client so the crypto can be tested on its own,
 * and so a future change of token format touches one file.
 */

export type RoundPayload = {
  verseKey: string;
  chapterId: number;
  reciterId: number;
  audioUrl: string;
  attemptsUsed: number;
  hintPenalty: number;
  attemptId: string;
  roundId: string;
  revision: number;
  issuedAt: number;
};

const IV_BYTES = 12;
const TAG_BYTES = 16;
export const ROUND_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export class RoundTokenError extends Error {
  /** Read structurally by the HTTP layer, which maps it to 400. */
  readonly kind = "bad_request" as const;

  constructor(message = "This round token is invalid or expired. Start a new round.") {
    super(message);
    this.name = "RoundTokenError";
  }
}

function encryptionKey() {
  return crypto.createHash("sha256").update(roundTokenSecret()).digest();
}

export function sealRound(payload: RoundPayload) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function openRound(token: string, now = Date.now()): RoundPayload {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new RoundTokenError();

    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encrypted = raw.subarray(IV_BYTES + TAG_BYTES);

    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const payload = JSON.parse(decrypted) as RoundPayload;

    if (!isCompletePayload(payload)) throw new RoundTokenError();
    if (!payload.issuedAt || now - payload.issuedAt > ROUND_TOKEN_TTL_MS) throw new RoundTokenError();
    return payload;
  } catch (error) {
    // Deliberately uniform: distinguishing "bad signature" from "expired" from
    // "malformed" would tell someone probing the endpoint which part of a
    // forged token they got right.
    if (error instanceof RoundTokenError) throw error;
    throw new RoundTokenError();
  }
}

function isCompletePayload(payload: RoundPayload) {
  return Boolean(
    payload &&
    typeof payload.verseKey === "string" && payload.verseKey &&
    Number.isInteger(payload.chapterId) && payload.chapterId >= 1 && payload.chapterId <= 114 &&
    Number.isFinite(payload.reciterId) &&
    typeof payload.audioUrl === "string" && payload.audioUrl &&
    typeof payload.attemptsUsed === "number" &&
    typeof payload.hintPenalty === "number" &&
    typeof payload.attemptId === "string" && payload.attemptId &&
    typeof payload.roundId === "string" && payload.roundId &&
    typeof payload.revision === "number",
  );
}
