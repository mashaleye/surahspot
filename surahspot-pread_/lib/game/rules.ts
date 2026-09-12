/**
 * The rules of SurahSpot, as pure functions over plain numbers.
 *
 * These constants used to exist in four places at once: the guess route
 * (`Math.max(20, 100 - attemptsUsed * 20)`), the hint route (the same
 * expression again), the React component (`5 - round.attemptsRemaining`, and a
 * literal `[100, 80, 60, 40, 20]` ladder), and the rule card copy. Changing the
 * scoring curve meant finding all of them.
 *
 * Nothing here imports Next, React, node:crypto, or any store. That is what
 * makes the scoring rules directly unit-testable, and it is why a future
 * variant — a timed mode, a five-round attempt, a different hint price — is a
 * change to this file rather than surgery across the request path.
 */

export const MAX_TRIES_PER_ROUND = 5;
export const MAX_ATTEMPT_ROUNDS = 7;
export const MAX_ATTEMPT_HINTS = 2;

export const STARTING_POINTS = 100;
export const POINTS_LOST_PER_TRY = 20;
export const MINIMUM_CORRECT_POINTS = 20;

/** The first hint of an attempt is free; the second costs points in its round. */
export const FIRST_HINT_COST = 0;
export const SECOND_HINT_COST = 3;

export type HintType = "meaning" | "ayah_count" | "juz" | "revelation_place";

export const HINT_TYPES: readonly HintType[] = ["meaning", "ayah_count", "juz", "revelation_place"];

const HINT_TYPE_SET = new Set<string>(HINT_TYPES);

export function isHintType(value: unknown): value is HintType {
  return typeof value === "string" && HINT_TYPE_SET.has(value);
}

/**
 * Points still on the table before any hint deduction.
 *
 * Try 1 is worth 100 and each spent try costs 20, with a floor of 20 so a
 * player who answers correctly on the last try still scores. The floor is why
 * this is not simply `100 - used * 20`: at five used tries that expression
 * gives 0, which is the "ran out" score, not a "correct on the final try" score.
 */
export function basePointsForTriesUsed(triesUsed: number) {
  const used = clampTries(triesUsed);
  return Math.max(MINIMUM_CORRECT_POINTS, STARTING_POINTS - used * POINTS_LOST_PER_TRY);
}

/** Points displayed as still achievable, after hint deductions. */
export function potentialPoints(triesUsed: number, hintPenalty: number) {
  return Math.max(0, basePointsForTriesUsed(triesUsed) - Math.max(0, hintPenalty));
}

/** Final award for a correct answer. */
export function pointsForCorrectGuess(triesUsed: number, hintPenalty: number) {
  return potentialPoints(triesUsed, hintPenalty);
}

export function triesRemaining(triesUsed: number) {
  return Math.max(0, MAX_TRIES_PER_ROUND - clampTries(triesUsed));
}

export function isRoundExhausted(triesUsed: number) {
  return clampTries(triesUsed) >= MAX_TRIES_PER_ROUND;
}

/** Cost of the next hint, or null when the attempt allowance is spent. */
export function nextHintCost(hintsUsed: number): number | null {
  if (hintsUsed <= 0) return FIRST_HINT_COST;
  if (hintsUsed === 1) return SECOND_HINT_COST;
  return null;
}

export function hintsRemaining(hintsUsed: number) {
  return Math.max(0, MAX_ATTEMPT_HINTS - Math.max(0, hintsUsed));
}

/** The points ladder the rule card renders. Derived, never hand-written. */
export function scoreLadder() {
  return Array.from({ length: MAX_TRIES_PER_ROUND }, (_, index) => ({
    try: index + 1,
    points: basePointsForTriesUsed(index),
  }));
}

export function isAttemptComplete(roundsCompleted: number) {
  return roundsCompleted >= MAX_ATTEMPT_ROUNDS;
}

export function isValidChapterId(value: unknown): value is number {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 && id <= 114;
}

function clampTries(triesUsed: number) {
  if (!Number.isFinite(triesUsed) || triesUsed < 0) return 0;
  return Math.min(MAX_TRIES_PER_ROUND, Math.floor(triesUsed));
}
