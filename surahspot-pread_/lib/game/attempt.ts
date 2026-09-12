import {
  MAX_ATTEMPT_HINTS,
  MAX_ATTEMPT_ROUNDS,
  type HintType,
  hintsRemaining,
  isAttemptComplete,
  isHintType,
  nextHintCost,
} from "./rules";

/**
 * Attempt state as a plain, JSON-serializable record, plus the pure transitions
 * that act on it.
 *
 * The previous version used `Map` and `Set` inside the state object and mutated
 * it in place in a module-level Map. That shape cannot round-trip through Redis
 * — `JSON.stringify(new Set())` is `{}` — so the storage backend and the game
 * rules were welded together. Here the record is ordinary JSON and every
 * transition is a function over it, which means the rules can be tested with no
 * store at all and the store can be swapped with no rule changes.
 *
 * Transitions mutate the record they are handed and let the caller persist it.
 * The caller always holds the store lock for that attempt, so the mutation is
 * not observable until it is written back.
 */

export const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;

export type RoundRecord = {
  revision: number;
  finished: boolean;
  /** Hint types already revealed in this round, as an array so it serializes. */
  revealedHints: HintType[];
};

export type AttemptRecord = {
  id: string;
  createdAt: number;
  hintsUsed: number;
  roundsCompleted: number;
  rounds: Record<string, RoundRecord>;
};

export type HintStatus = {
  hintsUsed: number;
  hintsRemaining: number;
  nextHintCost: number | null;
};

/** Thrown for rule violations the player can see and act on. */
export class AttemptRuleError extends Error {
  readonly kind: "conflict" | "bad_request";

  constructor(message: string, kind: "conflict" | "bad_request" = "conflict") {
    super(message);
    this.name = "AttemptRuleError";
    this.kind = kind;
  }
}

export function newAttemptRecord(id: string, now = Date.now()): AttemptRecord {
  return { id, createdAt: now, hintsUsed: 0, roundsCompleted: 0, rounds: {} };
}

/**
 * Recover a usable record from whatever the store returned.
 *
 * Anything read back could be from an older deploy with a different shape, or
 * truncated. Coercing field by field means a schema change ages out gracefully
 * instead of throwing on every request until the TTL expires.
 */
export function reviveAttemptRecord(value: unknown): AttemptRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<AttemptRecord>;
  if (typeof record.id !== "string" || !record.id) return null;

  const rounds: Record<string, RoundRecord> = {};
  if (record.rounds && typeof record.rounds === "object") {
    for (const [roundId, round] of Object.entries(record.rounds)) {
      if (!round || typeof round !== "object") continue;
      const candidate = round as Partial<RoundRecord>;
      rounds[roundId] = {
        revision: clampCount(candidate.revision, Number.MAX_SAFE_INTEGER),
        finished: candidate.finished === true,
        revealedHints: Array.isArray(candidate.revealedHints)
          ? candidate.revealedHints.filter(isHintType)
          : [],
      };
    }
  }

  return {
    id: record.id,
    createdAt: Number(record.createdAt) > 0 ? Number(record.createdAt) : Date.now(),
    hintsUsed: clampCount(record.hintsUsed, MAX_ATTEMPT_HINTS),
    roundsCompleted: clampCount(record.roundsCompleted, MAX_ATTEMPT_ROUNDS),
    rounds,
  };
}

export function registerRound(attempt: AttemptRecord, roundId: string) {
  if (isAttemptComplete(attempt.roundsCompleted)) {
    throw new AttemptRuleError("This seven-round attempt is complete. Start a new attempt to keep playing.");
  }
  attempt.rounds[roundId] = { revision: 0, finished: false, revealedHints: [] };
  pruneFinishedRounds(attempt);
  return { roundId, revision: 0 };
}

export function assertRoundActive(attempt: AttemptRecord, roundId: string, revision: number) {
  const round = attempt.rounds[roundId];
  if (!round || round.finished) {
    throw new AttemptRuleError("This round is no longer active. Start the next round.");
  }
  if (round.revision !== revision) {
    throw new AttemptRuleError("This round action used stale state. Refresh the current round and try again.");
  }
  return round;
}

export function rotateRoundRevision(attempt: AttemptRecord, roundId: string, revision: number) {
  const round = assertRoundActive(attempt, roundId, revision);
  round.revision += 1;
  return round.revision;
}

export function finishRound(attempt: AttemptRecord, roundId: string, revision: number) {
  const round = assertRoundActive(attempt, roundId, revision);
  round.finished = true;
  round.revision += 1;
  attempt.roundsCompleted = Math.min(MAX_ATTEMPT_ROUNDS, attempt.roundsCompleted + 1);
  return attempt.roundsCompleted;
}

export function hintStatus(attempt: AttemptRecord): HintStatus {
  return {
    hintsUsed: attempt.hintsUsed,
    hintsRemaining: hintsRemaining(attempt.hintsUsed),
    nextHintCost: nextHintCost(attempt.hintsUsed),
  };
}

export function consumeHint(
  attempt: AttemptRecord,
  roundId: string,
  revision: number,
  hintType: HintType,
) {
  const round = assertRoundActive(attempt, roundId, revision);
  if (!isHintType(hintType)) {
    throw new AttemptRuleError("That hint type is not available.", "bad_request");
  }
  if (attempt.hintsUsed >= MAX_ATTEMPT_HINTS) {
    throw new AttemptRuleError("Both hints for this seven-round attempt have already been used.");
  }
  if (round.revealedHints.includes(hintType)) {
    throw new AttemptRuleError("That hint has already been revealed for this round. Choose a different hint type.");
  }

  const cost = nextHintCost(attempt.hintsUsed) ?? 0;
  attempt.hintsUsed += 1;
  round.revealedHints.push(hintType);
  round.revision += 1;

  return { cost, revision: round.revision, ...hintStatus(attempt) };
}

export function canStartNewAttempt(attempt: AttemptRecord | null) {
  return !attempt || isAttemptComplete(attempt.roundsCompleted);
}

/** Server-authoritative progress, echoed to the client so it can reconcile. */
export function attemptProgress(attempt: AttemptRecord) {
  return {
    roundsCompleted: attempt.roundsCompleted,
    roundsRemaining: Math.max(0, MAX_ATTEMPT_ROUNDS - attempt.roundsCompleted),
    complete: isAttemptComplete(attempt.roundsCompleted),
  };
}

/**
 * Keep only the rounds still needed for replay checks.
 *
 * Finished rounds are retained briefly so a duplicate submission gets "this
 * round is over" rather than "unknown round", but an attempt never needs more
 * than a handful, and unbounded growth would bloat every store write.
 */
function pruneFinishedRounds(attempt: AttemptRecord, keep = MAX_ATTEMPT_ROUNDS * 2) {
  const ids = Object.keys(attempt.rounds);
  if (ids.length <= keep) return;
  for (const id of ids.slice(0, ids.length - keep)) {
    if (attempt.rounds[id]?.finished) delete attempt.rounds[id];
  }
}

function clampCount(value: unknown, max: number) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.min(max, Math.floor(count));
}
