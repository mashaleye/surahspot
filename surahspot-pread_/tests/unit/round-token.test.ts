import { describe, expect, it } from "vitest";
import { ROUND_TOKEN_TTL_MS, RoundTokenError, openRound, sealRound } from "@/lib/quran/round-token";

/**
 * The round token is the whole anti-cheat model. If it can be read, forged, or
 * replayed, every other control is decoration. TC-053, TC-054 and TC-097.
 */

function samplePayload(overrides: Partial<Parameters<typeof sealRound>[0]> = {}) {
  return {
    verseKey: "36:12",
    chapterId: 36,
    reciterId: 7,
    audioUrl: "https://audio.example.com/7/36.mp3",
    attemptsUsed: 0,
    hintPenalty: 0,
    attemptId: "attempt-abc",
    roundId: "round-xyz",
    revision: 0,
    issuedAt: Date.now(),
    ...overrides,
  };
}

describe("round token", () => {
  it("round-trips a payload intact", () => {
    const payload = samplePayload();
    expect(openRound(sealRound(payload))).toEqual(payload);
  });

  it("does not expose the answer in the encoded token", () => {
    // TC-053: the chapter id and verse key must not be readable by decoding the
    // token in DevTools. base64url decoding it should yield ciphertext.
    const token = sealRound(samplePayload());
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    expect(decoded).not.toContain("36:12");
    expect(decoded).not.toContain("chapterId");
    expect(decoded).not.toContain("audio.example.com");
  });

  it("rejects a token whose ciphertext was altered", () => {
    // TC-097: flipping a byte in the sealed audio URL must fail authentication
    // rather than proxying a substituted host.
    const token = sealRound(samplePayload());
    const raw = Buffer.from(token, "base64url");
    raw[raw.length - 5] ^= 0xff;
    expect(() => openRound(raw.toString("base64url"))).toThrow(RoundTokenError);
  });

  it("rejects a token whose authentication tag was altered", () => {
    const token = sealRound(samplePayload());
    const raw = Buffer.from(token, "base64url");
    raw[14] ^= 0x01; // inside the 16-byte GCM tag
    expect(() => openRound(raw.toString("base64url"))).toThrow(RoundTokenError);
  });

  it("rejects truncated and empty tokens", () => {
    expect(() => openRound("")).toThrow(RoundTokenError);
    expect(() => openRound("abc")).toThrow(RoundTokenError);
    const token = sealRound(samplePayload());
    expect(() => openRound(token.slice(0, 20))).toThrow(RoundTokenError);
  });

  it("rejects a token past its lifetime", () => {
    const token = sealRound(samplePayload({ issuedAt: Date.now() }));
    const wellPastExpiry = Date.now() + ROUND_TOKEN_TTL_MS + 1_000;
    expect(() => openRound(token, wellPastExpiry)).toThrow(RoundTokenError);
  });

  it("gives the same message for every failure mode", () => {
    // Distinguishing "bad signature" from "expired" would tell someone probing
    // the endpoint which part of a forged token they got right.
    const messages = new Set<string>();
    for (const bad of ["", "zzzz", sealRound(samplePayload()).slice(0, 30)]) {
      try {
        openRound(bad);
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });

  it("rejects a structurally valid payload with an impossible chapter id", () => {
    const token = sealRound(samplePayload({ chapterId: 900 }));
    expect(() => openRound(token)).toThrow(RoundTokenError);
  });

  it("produces a different token each time for the same payload", () => {
    // A fresh IV per seal. Identical tokens would let an observer detect when
    // two rounds carry the same answer.
    const payload = samplePayload();
    expect(sealRound(payload)).not.toBe(sealRound(payload));
  });

  it("refuses a token sealed under a different secret", () => {
    const token = sealRound(samplePayload());
    const original = process.env.ROUND_TOKEN_SECRET;
    process.env.ROUND_TOKEN_SECRET = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    try {
      expect(() => openRound(token)).toThrow(RoundTokenError);
    } finally {
      process.env.ROUND_TOKEN_SECRET = original;
    }
  });

  it("refuses to operate with a weak secret", () => {
    const original = process.env.ROUND_TOKEN_SECRET;
    process.env.ROUND_TOKEN_SECRET = "too-short";
    try {
      expect(() => sealRound(samplePayload())).toThrow(/at least 32/i);
    } finally {
      process.env.ROUND_TOKEN_SECRET = original;
    }
  });
});
