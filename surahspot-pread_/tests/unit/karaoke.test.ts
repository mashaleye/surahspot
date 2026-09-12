import { describe, expect, it } from "vitest";
import {
  type Segment,
  hasUsableTiming,
  karaokeStatesMatch,
  normalizeSegments,
  resolveKaraokeState,
} from "@/lib/quran/karaoke";

/**
 * Word-level highlight synchronization. TC-072 to TC-082.
 *
 * Every case here is expressed in absolute chapter-milliseconds, because that
 * is what Quran Foundation returns and converting to verse-relative time was a
 * bug the original implementation explicitly warns against.
 */

const SEGMENTS: Segment[] = [
  [1, 1000, 1400],
  [2, 1400, 1900],
  // A deliberate silence between words 2 and 3.
  [3, 2400, 2900],
];

describe("segment normalization", () => {
  it("sorts segments that arrive out of order", () => {
    // TC-081: the resolver stops at the first word that has not started, so
    // unsorted input would truncate the highlight partway through the ayah.
    const scrambled: unknown = [[3, 2400, 2900], [1, 1000, 1400], [2, 1400, 1900]];
    expect(normalizeSegments(scrambled)).toEqual(SEGMENTS);
  });

  it("drops segments that cannot describe a word", () => {
    const messy: unknown = [
      [1, 1000, 1400],
      [2, 1900, 1400],      // ends before it starts
      [0, 2000, 2400],      // position is 1-based, 0 is invalid
      [3, "x", 2900],       // non-numeric
      [4, 3000],            // too short
      null,
      "nonsense",
    ];
    expect(normalizeSegments(messy)).toEqual([[1, 1000, 1400]]);
  });

  it("returns an empty list for anything that is not an array", () => {
    // TC-082: no segments means the round builder rejects the recitation
    // rather than displaying static text against moving audio.
    expect(normalizeSegments(null)).toEqual([]);
    expect(normalizeSegments(undefined)).toEqual([]);
    expect(normalizeSegments({})).toEqual([]);
  });

  it("recognises unusable timing", () => {
    expect(hasUsableTiming([], 0, 100)).toBe(false);
    expect(hasUsableTiming(SEGMENTS, 1000, 1000)).toBe(false);
    expect(hasUsableTiming(SEGMENTS, 950, 2950)).toBe(true);
  });
});

describe("playback state", () => {
  it("highlights no word before the first one starts", () => {
    expect(resolveKaraokeState(SEGMENTS, 500)).toEqual({
      activePosition: -1,
      completedPosition: 0,
      wordProgress: 0,
    });
  });

  it("activates the first word at its own timestamp", () => {
    // TC-072 / TC-074: QF position 1 maps to the first rendered word, not to
    // array index 1.
    const state = resolveKaraokeState(SEGMENTS, 1000);
    expect(state.activePosition).toBe(1);
    expect(state.wordProgress).toBe(0);
  });

  it("switches word exactly at a shared boundary", () => {
    // TC-075: word 1 ends and word 2 starts at 1400. The new word wins.
    expect(resolveKaraokeState(SEGMENTS, 1399).activePosition).toBe(1);
    expect(resolveKaraokeState(SEGMENTS, 1400).activePosition).toBe(2);
  });

  it("reports fractional progress through the active word", () => {
    const state = resolveKaraokeState(SEGMENTS, 1200);
    expect(state.activePosition).toBe(1);
    expect(state.wordProgress).toBeCloseTo(0.5, 5);
  });

  it("holds no word active during silence but keeps prior words complete", () => {
    // TC-076: the text must not appear to un-recite itself in the gap.
    const state = resolveKaraokeState(SEGMENTS, 2100);
    expect(state.activePosition).toBe(-1);
    expect(state.completedPosition).toBe(2);
  });

  it("marks every word complete after the last one ends", () => {
    // TC-063 boundary: playback past the ayah leaves the full ayah highlighted.
    expect(resolveKaraokeState(SEGMENTS, 5000)).toEqual({
      activePosition: -1,
      completedPosition: 3,
      wordProgress: 0,
    });
  });

  it("rewinds correctly when the player seeks backward", () => {
    // TC-065 / TC-077: state is derived from currentTime, so seeking back to
    // 1100 must produce exactly the state of first playing 1100.
    const forward = resolveKaraokeState(SEGMENTS, 2600);
    expect(forward.activePosition).toBe(3);

    const rewound = resolveKaraokeState(SEGMENTS, 1100);
    expect(rewound.activePosition).toBe(1);
    expect(rewound.completedPosition).toBe(0);
  });

  it("catches up rather than drifting after a frame-rate stall", () => {
    // TC-079 / TC-080: a stalled tab resumes at the audio's position, not at
    // the position the next frame would have advanced to.
    const afterStall = resolveKaraokeState(SEGMENTS, 2800);
    expect(afterStall.activePosition).toBe(3);
    expect(afterStall.completedPosition).toBe(2);
  });

  it("survives a long ayah without losing alignment", () => {
    // TC-073: 40 words, checked at each word's midpoint.
    const long: Segment[] = Array.from({ length: 40 }, (_, index) => [
      index + 1,
      index * 500,
      index * 500 + 450,
    ]);
    for (let position = 1; position <= 40; position += 1) {
      const midpoint = (position - 1) * 500 + 225;
      expect(resolveKaraokeState(long, midpoint).activePosition).toBe(position);
    }
  });

  it("ignores degenerate segments that slipped through", () => {
    const withJunk: Segment[] = [[1, 1000, 1400], [2, 1500, 1500], [3, 1600, 2000]];
    expect(resolveKaraokeState(withJunk, 1550).activePosition).toBe(-1);
    expect(resolveKaraokeState(withJunk, 1700).activePosition).toBe(3);
  });
});

describe("render-skip comparison", () => {
  it("treats imperceptible progress changes as equal", () => {
    // TC-078: without this the component re-renders every animation frame,
    // which is what accumulated duplicate work across repeated pause/resume.
    const a = { activePosition: 2, completedPosition: 1, wordProgress: 0.500 };
    const b = { activePosition: 2, completedPosition: 1, wordProgress: 0.505 };
    expect(karaokeStatesMatch(a, b)).toBe(true);
  });

  it("treats a word change as a difference regardless of progress", () => {
    const a = { activePosition: 2, completedPosition: 1, wordProgress: 0.5 };
    const b = { activePosition: 3, completedPosition: 2, wordProgress: 0.5 };
    expect(karaokeStatesMatch(a, b)).toBe(false);
  });
});
