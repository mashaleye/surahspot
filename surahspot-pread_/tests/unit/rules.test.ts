import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPT_HINTS,
  MAX_ATTEMPT_ROUNDS,
  MAX_TRIES_PER_ROUND,
  basePointsForTriesUsed,
  hintsRemaining,
  isAttemptComplete,
  isHintType,
  isRoundExhausted,
  isValidChapterId,
  nextHintCost,
  pointsForCorrectGuess,
  potentialPoints,
  scoreLadder,
  triesRemaining,
} from "@/lib/game/rules";

/**
 * Scoring is the rule players notice immediately when it breaks, and it is
 * pure arithmetic, so it is the cheapest thing in the codebase to pin down
 * exactly. These cases mirror TC-002 to TC-009 and TC-049 to TC-052 in the
 * test plan.
 */
describe("scoring ladder", () => {
  it.each([
    // [tries used before the correct answer, expected award]  TC-002..TC-006
    [0, 100],
    [1, 80],
    [2, 60],
    [3, 40],
    [4, 20],
  ])("awards %i-try correct answer %i points", (triesUsed, expected) => {
    expect(pointsForCorrectGuess(triesUsed, 0)).toBe(expected);
  });

  it("floors a correct final-try answer at 20 rather than 0", () => {
    // The naive formula 100 - used * 20 gives 0 at five used tries, which is
    // the "ran out" score. A player who answers on the last try has not run out.
    expect(basePointsForTriesUsed(MAX_TRIES_PER_ROUND)).toBe(20);
  });

  it("renders the ladder the rule card shows", () => {
    expect(scoreLadder()).toEqual([
      { try: 1, points: 100 },
      { try: 2, points: 80 },
      { try: 3, points: 60 },
      { try: 4, points: 40 },
      { try: 5, points: 20 },
    ]);
  });

  it("treats a skipped try exactly like a wrong guess", () => {
    // TC-008 / TC-009: "Skip this try" spends a try and nothing else, so four
    // skips then a correct answer is worth 20.
    expect(potentialPoints(1, 0)).toBe(80);
    expect(pointsForCorrectGuess(4, 0)).toBe(20);
  });

  it("clamps nonsensical try counts instead of producing negative scores", () => {
    expect(basePointsForTriesUsed(-3)).toBe(100);
    expect(basePointsForTriesUsed(99)).toBe(20);
    expect(basePointsForTriesUsed(Number.NaN)).toBe(100);
  });
});

describe("hint deductions", () => {
  it("charges nothing for the first hint of an attempt", () => {
    // TC-041
    expect(nextHintCost(0)).toBe(0);
  });

  it("charges 3 points for the second hint", () => {
    // TC-042
    expect(nextHintCost(1)).toBe(3);
  });

  it("offers no third hint", () => {
    // TC-043: the cost is null, which is what the route turns into a refusal.
    expect(nextHintCost(2)).toBeNull();
    expect(nextHintCost(5)).toBeNull();
  });

  it.each([
    // [tries used, base potential, potential after a paid hint]
    [0, 100, 97], // TC-049
    [1, 80, 77],  // TC-050
    [4, 20, 17],  // TC-051
  ])("reduces potential from %i tries: %i becomes %i", (triesUsed, base, afterHint) => {
    expect(potentialPoints(triesUsed, 0)).toBe(base);
    expect(potentialPoints(triesUsed, 3)).toBe(afterHint);
  });

  it("includes the hint deduction in the awarded score", () => {
    // TC-052
    expect(pointsForCorrectGuess(1, 3)).toBe(77);
  });

  it("never returns a negative score, however large the penalty", () => {
    expect(potentialPoints(4, 999)).toBe(0);
    // A negative penalty submitted by a tampered client must not inflate the
    // score. TC-058 covers the request-level rejection; this is the arithmetic.
    expect(potentialPoints(0, -50)).toBe(100);
  });

  it("counts down the attempt-wide allowance", () => {
    expect(hintsRemaining(0)).toBe(MAX_ATTEMPT_HINTS);
    expect(hintsRemaining(1)).toBe(1);
    expect(hintsRemaining(2)).toBe(0);
    expect(hintsRemaining(7)).toBe(0);
  });
});

describe("round and attempt boundaries", () => {
  it("reports tries remaining from tries used", () => {
    expect(triesRemaining(0)).toBe(5);
    expect(triesRemaining(5)).toBe(0);
  });

  it("ends the round after five tries", () => {
    // TC-007
    expect(isRoundExhausted(4)).toBe(false);
    expect(isRoundExhausted(5)).toBe(true);
  });

  it("ends the attempt after seven rounds", () => {
    // TC-015: there is no round 8.
    expect(isAttemptComplete(MAX_ATTEMPT_ROUNDS - 1)).toBe(false);
    expect(isAttemptComplete(MAX_ATTEMPT_ROUNDS)).toBe(true);
  });
});

describe("input validation", () => {
  it("accepts only real chapter ids", () => {
    expect(isValidChapterId(1)).toBe(true);
    expect(isValidChapterId(114)).toBe(true);
    expect(isValidChapterId(0)).toBe(false);
    expect(isValidChapterId(115)).toBe(false);
    expect(isValidChapterId(2.5)).toBe(false);
    expect(isValidChapterId("2")).toBe(true); // coerced, matching the route
    expect(isValidChapterId("two")).toBe(false);
    expect(isValidChapterId(null)).toBe(false);
  });

  it("accepts only the four published hint types", () => {
    // TC-059: "chapterId" is exactly the probe this guards against.
    expect(isHintType("juz")).toBe(true);
    expect(isHintType("chapterId")).toBe(false);
    expect(isHintType("__proto__")).toBe(false);
    expect(isHintType(undefined)).toBe(false);
  });
});
