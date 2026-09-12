/**
 * Word-timing normalization and playback lookup.
 *
 * These two functions are two halves of one contract and they used to live in
 * different files — `cleanSegments` in the round route, `resolveKaraokeState`
 * inside the React component — with the invariant that segments arrive sorted
 * only stated in a comment on one side. Keeping them together means a change to
 * the sort or the filter is visible to the code that depends on it, and it lets
 * both be tested without a browser or a Next request.
 *
 * Segment shape is Quran Foundation's: [wordPosition, startMs, endMs], where
 * wordPosition is 1-based within the ayah and the timestamps are absolute
 * offsets into the whole chapter recording. They are not verse-relative.
 */

export type Segment = [position: number, startMs: number, endMs: number];

export type KaraokeState = {
  /** 1-based position of the word being recited, or -1 during silence. */
  activePosition: number;
  /** Highest position already finished. Words at or below this are "passed". */
  completedPosition: number;
  /** 0..1 progress through the active word, used for the per-word fill. */
  wordProgress: number;
};

export const EMPTY_KARAOKE: KaraokeState = { activePosition: -1, completedPosition: 0, wordProgress: 0 };

/**
 * Drop unusable segments and sort by start time.
 *
 * Upstream data is not guaranteed ordered, and `resolveKaraokeState` walks the
 * list and stops at the first word that has not started yet — so an unsorted
 * list would truncate the highlight partway through the ayah. Normalizing on
 * the server means the browser never sees a list it cannot trust, and the sort
 * cost is paid once per round instead of once per animation frame.
 */
export function normalizeSegments(segments: unknown): Segment[] {
  if (!Array.isArray(segments)) return [];

  return segments
    .filter((segment): segment is Segment =>
      Array.isArray(segment) &&
      segment.length >= 3 &&
      segment.slice(0, 3).every((value) => Number.isFinite(value)) &&
      segment[0] >= 1 &&
      segment[2] > segment[1])
    .map((segment) => [segment[0], segment[1], segment[2]] as Segment)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/**
 * Which word is being recited at `currentMs`.
 *
 * Derived from `audio.currentTime` rather than from a frame counter, so a
 * dropped frame or a backgrounded tab causes the highlight to jump to the right
 * word on the next frame instead of drifting permanently behind the audio.
 *
 * Between segments — the natural pauses inside an ayah — no word is active but
 * everything before the gap stays marked complete, so the text does not appear
 * to un-recite itself during silence.
 */
export function resolveKaraokeState(segments: readonly Segment[], currentMs: number): KaraokeState {
  let completedPosition = 0;

  for (const [position, startMs, endMs] of segments) {
    if (!Number.isFinite(position) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

    if (currentMs < startMs) {
      return { activePosition: -1, completedPosition, wordProgress: 0 };
    }

    if (currentMs < endMs) {
      const wordProgress = Math.min(1, Math.max(0, (currentMs - startMs) / (endMs - startMs)));
      return { activePosition: position, completedPosition, wordProgress };
    }

    completedPosition = Math.max(completedPosition, position);
  }

  return { activePosition: -1, completedPosition, wordProgress: 0 };
}

/** True when two states would render identically, used to skip React updates. */
export function karaokeStatesMatch(a: KaraokeState, b: KaraokeState, progressEpsilon = 0.015) {
  return (
    a.activePosition === b.activePosition &&
    a.completedPosition === b.completedPosition &&
    Math.abs(a.wordProgress - b.wordProgress) < progressEpsilon
  );
}

/**
 * Whether a recitation can actually drive the highlight for an ayah.
 *
 * A round built on empty or degenerate timing would show static Arabic while
 * audio plays, which reads as a bug rather than as missing data — so the round
 * builder skips these rather than shipping fake synchronization.
 */
export function hasUsableTiming(segments: readonly Segment[], fromMs: number, toMs: number) {
  if (!segments.length) return false;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return false;
  return toMs > fromMs;
}
