import { describe, expect, it } from "vitest";
import {
  AttemptRuleError,
  assertRoundActive,
  attemptProgress,
  canStartNewAttempt,
  consumeHint,
  finishRound,
  hintStatus,
  newAttemptRecord,
  registerRound,
  reviveAttemptRecord,
  rotateRoundRevision,
} from "@/lib/game/attempt";
import { MAX_ATTEMPT_ROUNDS } from "@/lib/game/rules";

/**
 * Attempt-scoped rules: the two-hint allowance, one-shot round revisions, and
 * the seven-round ceiling. Covers TC-040 to TC-044, TC-054 to TC-061, and
 * TC-016 to TC-020.
 */

function attemptWithRound() {
  const attempt = newAttemptRecord("attempt-1");
  const { roundId, revision } = registerRound(attempt, "round-1");
  return { attempt, roundId, revision };
}

describe("hint allowance", () => {
  it("starts an attempt with two hints", () => {
    // TC-040
    const attempt = newAttemptRecord("a");
    expect(hintStatus(attempt)).toEqual({ hintsUsed: 0, hintsRemaining: 2, nextHintCost: 0 });
  });

  it("makes the first hint free and the second cost 3", () => {
    // TC-041 / TC-042
    const { attempt, roundId } = attemptWithRound();
    const first = consumeHint(attempt, roundId, 0, "juz");
    expect(first.cost).toBe(0);
    expect(first.hintsRemaining).toBe(1);

    const second = consumeHint(attempt, roundId, first.revision, "ayah_count");
    expect(second.cost).toBe(3);
    expect(second.hintsRemaining).toBe(0);
    expect(second.nextHintCost).toBeNull();
  });

  it("refuses a third hint", () => {
    // TC-043
    const { attempt, roundId } = attemptWithRound();
    const first = consumeHint(attempt, roundId, 0, "juz");
    const second = consumeHint(attempt, roundId, first.revision, "meaning");
    expect(() => consumeHint(attempt, roundId, second.revision, "ayah_count"))
      .toThrow(/already been used/i);
  });

  it("enforces the allowance across rounds, not within one", () => {
    // TC-044: a hint in round 1 and a hint in round 7 still exhausts it.
    const attempt = newAttemptRecord("a");
    const roundOne = registerRound(attempt, "round-1");
    consumeHint(attempt, roundOne.roundId, roundOne.revision, "juz");
    finishRound(attempt, roundOne.roundId, 1);

    const roundSeven = registerRound(attempt, "round-7");
    const second = consumeHint(attempt, roundSeven.roundId, roundSeven.revision, "juz");
    expect(second.cost).toBe(3);

    const roundEight = registerRound(attempt, "round-8");
    expect(() => consumeHint(attempt, roundEight.roundId, roundEight.revision, "meaning"))
      .toThrow(AttemptRuleError);
  });

  it("refuses the same hint type twice in one round", () => {
    // TC-061: repeating a request to infer state gets a flat refusal, and
    // crucially does not spend the allowance a second time.
    const { attempt, roundId } = attemptWithRound();
    const first = consumeHint(attempt, roundId, 0, "juz");
    expect(() => consumeHint(attempt, roundId, first.revision, "juz")).toThrow(/already been revealed/i);
    expect(attempt.hintsUsed).toBe(1);
  });

  it("does not spend the allowance when the revision is stale", () => {
    const { attempt, roundId } = attemptWithRound();
    consumeHint(attempt, roundId, 0, "juz");
    // Replaying revision 0 after it was consumed.
    expect(() => consumeHint(attempt, roundId, 0, "meaning")).toThrow(/stale state/i);
    expect(attempt.hintsUsed).toBe(1);
  });
});

describe("round revisions", () => {
  it("accepts the current revision exactly once", () => {
    // TC-054: a token saved before a paid hint is stale afterwards.
    const { attempt, roundId } = attemptWithRound();
    rotateRoundRevision(attempt, roundId, 0);
    expect(() => assertRoundActive(attempt, roundId, 0)).toThrow(/stale state/i);
    expect(assertRoundActive(attempt, roundId, 1).revision).toBe(1);
  });

  it("advances the revision when a hint is consumed", () => {
    // TC-056: a hint and a guess cannot both claim the same revision.
    const { attempt, roundId } = attemptWithRound();
    const usage = consumeHint(attempt, roundId, 0, "juz");
    expect(usage.revision).toBe(1);
    expect(() => rotateRoundRevision(attempt, roundId, 0)).toThrow(/stale state/i);
  });

  it("refuses any action on a finished round", () => {
    // TC-020: a refresh right after a round ends must not award it twice.
    const { attempt, roundId } = attemptWithRound();
    finishRound(attempt, roundId, 0);
    expect(() => assertRoundActive(attempt, roundId, 1)).toThrow(/no longer active/i);
    expect(attempt.roundsCompleted).toBe(1);
  });

  it("refuses an unknown round id", () => {
    // TC-060: a token minted in another browser names a round this attempt
    // has never registered.
    const { attempt } = attemptWithRound();
    expect(() => assertRoundActive(attempt, "round-from-elsewhere", 0)).toThrow(/no longer active/i);
  });
});

describe("attempt progression", () => {
  it("counts exactly seven rounds and then stops issuing them", () => {
    // TC-016 / TC-015 / TC-027
    const attempt = newAttemptRecord("a");
    for (let index = 0; index < MAX_ATTEMPT_ROUNDS; index += 1) {
      const round = registerRound(attempt, `round-${index}`);
      finishRound(attempt, round.roundId, round.revision);
    }
    expect(attempt.roundsCompleted).toBe(MAX_ATTEMPT_ROUNDS);
    expect(attemptProgress(attempt)).toEqual({
      roundsCompleted: 7,
      roundsRemaining: 0,
      complete: true,
    });
    expect(() => registerRound(attempt, "round-8")).toThrow(/attempt is complete/i);
  });

  it("allows a new attempt only once the current one finishes", () => {
    // TC-018
    // No attempt at all is always startable.
    expect(canStartNewAttempt(null)).toBe(true);

    // An attempt with rounds still left is not: TC-018 only allows a reset
    // once seven rounds are done, otherwise a player could reroll a bad Surah
    // by starting over.
    const attempt = newAttemptRecord("a");
    expect(canStartNewAttempt(attempt)).toBe(false);

    const round = registerRound(attempt, "round-1");
    finishRound(attempt, round.roundId, round.revision);
    expect(canStartNewAttempt(attempt)).toBe(false);

    attempt.roundsCompleted = MAX_ATTEMPT_ROUNDS;
    expect(canStartNewAttempt(attempt)).toBe(true);
  });
});

describe("record revival", () => {
  it("survives a JSON round trip", () => {
    // The whole point of the plain-object shape: this must work for Redis.
    const { attempt, roundId } = attemptWithRound();
    consumeHint(attempt, roundId, 0, "juz");

    const revived = reviveAttemptRecord(JSON.parse(JSON.stringify(attempt)));
    expect(revived).toEqual(attempt);
    expect(revived!.rounds[roundId].revealedHints).toEqual(["juz"]);
  });

  it("repairs a record written by an older or partial schema", () => {
    const revived = reviveAttemptRecord({
      id: "legacy",
      hintsUsed: "1",
      roundsCompleted: 99,
      rounds: { r1: { revision: "2", revealedHints: ["juz", "nonsense"] } },
    });
    expect(revived).toMatchObject({
      id: "legacy",
      hintsUsed: 1,
      roundsCompleted: MAX_ATTEMPT_ROUNDS,
    });
    // Unknown hint types are dropped, not carried forward.
    expect(revived!.rounds.r1).toEqual({ revision: 2, finished: false, revealedHints: ["juz"] });
  });

  it("rejects values that cannot be an attempt", () => {
    // TC-057: a fabricated cookie or a corrupted store entry starts a fresh
    // attempt rather than granting whatever it claims.
    expect(reviveAttemptRecord(null)).toBeNull();
    expect(reviveAttemptRecord("attempt")).toBeNull();
    expect(reviveAttemptRecord({ hintsUsed: 0 })).toBeNull();
    expect(reviveAttemptRecord({ id: "" })).toBeNull();
  });

  it("clamps a tampered hint count instead of trusting it", () => {
    const revived = reviveAttemptRecord({ id: "x", hintsUsed: -5, roundsCompleted: -1, rounds: {} });
    expect(revived!.hintsUsed).toBe(0);
    expect(revived!.roundsCompleted).toBe(0);
  });
});
