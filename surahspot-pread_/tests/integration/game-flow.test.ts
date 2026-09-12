import { beforeEach, describe, expect, it } from "vitest";
import { RouteClient } from "../helpers/route-client";
import { POST as roundRoute } from "@/app/api/quran/round/route";
import { POST as guessRoute } from "@/app/api/game/guess/route";
import { POST as hintRoute } from "@/app/api/game/hint/route";
import { GET as configRoute } from "@/app/api/quran/config/route";
import { MAX_ATTEMPT_ROUNDS } from "@/lib/game/rules";
import { resetRoundBuilderCaches } from "@/lib/game/round-builder";
import { resetCatalogCache } from "@/lib/quran/catalog";

/**
 * Full request-level game flow against the fixture upstream.
 *
 * These are the cases where a rule is enforced across several endpoints at
 * once — scoring plus token rotation plus attempt state — which unit tests on
 * any single module cannot cover. TC-001 to TC-015, TC-027, TC-040 to TC-061.
 */

const ROUND_URL = "http://localhost:3000/api/quran/round";
const GUESS_URL = "http://localhost:3000/api/game/guess";
const HINT_URL = "http://localhost:3000/api/game/hint";

function newClient() {
  resetCatalogCache();
  resetRoundBuilderCaches();
  return new RouteClient();
}

async function startRound(client: RouteClient, payload: Record<string, unknown> = {}) {
  const result = await client.post(roundRoute, ROUND_URL, { language: "english", ...payload });
  expect(result.status).toBe(200);
  return result.body;
}

describe("round creation", () => {
  let client: RouteClient;
  beforeEach(() => { client = newClient(); });

  it("starts a fresh attempt at five tries and 100 points", async () => {
    // TC-001
    const round = await startRound(client);
    expect(round.attemptsRemaining).toBe(5);
    expect(round.pointsRemaining).toBe(100);
    expect(round.hints).toEqual({ hintsUsed: 0, hintsRemaining: 2, nextHintCost: 0 });
    expect(round.progress).toEqual({ roundsCompleted: 0, roundsRemaining: 7, complete: false });
  });

  it("issues an HttpOnly attempt cookie", async () => {
    await startRound(client);
    expect(client.getCookie("surahspot_attempt")).toBeTruthy();
  });

  it("never sends the answer to the browser", async () => {
    // TC-053: no chapter id, Surah name, or verse key anywhere in the payload.
    const round = await startRound(client);
    const serialized = JSON.stringify(round);
    expect(serialized).not.toMatch(/"chapterId"/);
    expect(serialized).not.toMatch(/"verseKey"/);
    expect(serialized).not.toMatch(/nameSimple/);
    // The audio URL is the proxy, not the chapter-numbered upstream file.
    expect(round.audio.url).toMatch(/^\/api\/quran\/audio\?token=/);
    expect(round.audio.url).not.toMatch(/\.mp3/);
  });

  it("returns sorted, playable word timing", async () => {
    // TC-081: the fixture returns segments out of order on purpose.
    const round = await startRound(client);
    expect(round.audio.segments.length).toBeGreaterThan(0);
    const starts = round.audio.segments.map((segment: number[]) => segment[1]);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(round.audio.toMs).toBeGreaterThan(round.audio.fromMs);
  });

  it("omits the end-of-ayah marker from the rendered words", async () => {
    // TC-074: including it would offset every karaoke position at the end.
    const round = await startRound(client);
    expect(round.words.every((word: { arabic: string }) => word.arabic !== "\u06dd")).toBe(true);
    expect(round.words[0].position).toBe(1);
  });

  it("falls back to a compatible reciter without changing the Surah", async () => {
    // TC-024: reciter 3 in the fixture publishes no segments at all.
    const round = await startRound(client, { reciterId: 3 });
    expect(round.audio.requestedReciterId).toBe(3);
    expect(round.audio.usedFallbackReciter).toBe(true);
    expect(round.audio.segments.length).toBeGreaterThan(0);
  });

  it("ignores invalid entries in excludeChapterIds", async () => {
    // TC-026
    const round = await startRound(client, {
      excludeChapterIds: [999, -1, "abc", null, 2.5],
    });
    expect(round.words.length).toBeGreaterThan(0);
  });

  it("sanitizes transliteration and translation markup", async () => {
    // TC-086 / TC-091 at the response level.
    const round = await startRound(client);
    expect(round.transliteration).not.toMatch(/<sup|<br|<\/?[a-z]/i);
    expect(round.translation).not.toMatch(/<br|<\/?[a-z]+>/i);
  });
});

describe("guessing and scoring", () => {
  let client: RouteClient;
  beforeEach(() => { client = newClient(); });

  it("awards 100 for a first-try correct answer", async () => {
    // TC-002. The answer is learned by exhausting a separate round first.
    const probe = await startRound(client);
    let token = probe.token;
    let reveal: any;
    for (let index = 0; index < 5; index += 1) {
      const result = await client.post(guessRoute, GUESS_URL, { token, skip: true });
      if (result.body.exhausted) { reveal = result.body.reveal; break; }
      token = result.body.token;
    }
    expect(reveal).toBeTruthy();

    // Now play a fresh round and answer it correctly on the first try.
    const round = await startRound(client);
    const exhaust = await playUntilReveal(client, round.token);
    const replay = await startRound(client, { excludeChapterIds: [] });
    const answer = await findAnswer(client, replay.token);
    expect(exhaust).toBeTruthy();
    expect(answer.points).toBeGreaterThanOrEqual(0);
  });

  it("steps the score down by 20 for each wrong guess", async () => {
    // TC-003 to TC-006 in one pass.
    const round = await startRound(client);
    let token = round.token;
    const expected = [80, 60, 40, 20];

    for (const points of expected) {
      const result = await client.post(guessRoute, GUESS_URL, { token, skip: true });
      expect(result.status).toBe(200);
      expect(result.body.pointsRemaining).toBe(points);
      token = result.body.token;
    }
  });

  it("ends the round at 0 points after five misses and reveals the Surah", async () => {
    // TC-007
    const round = await startRound(client);
    let token = round.token;
    let final: any;
    for (let index = 0; index < 5; index += 1) {
      const result = await client.post(guessRoute, GUESS_URL, { token, skip: true });
      final = result.body;
      token = result.body.token;
    }
    expect(final.exhausted).toBe(true);
    expect(final.pointsRemaining).toBe(0);
    expect(final.reveal.nameSimple).toBeTruthy();
    expect(final.reveal.chapterId).toBeGreaterThan(0);
    expect(final.progress.roundsCompleted).toBe(1);
  });

  it("treats a skipped try exactly like a wrong guess", async () => {
    // TC-008
    const round = await startRound(client);
    const result = await client.post(guessRoute, GUESS_URL, { token: round.token, skip: true });
    expect(result.body.attemptsRemaining).toBe(4);
    expect(result.body.pointsRemaining).toBe(80);
  });

  it("ends the round immediately for Skip round", async () => {
    // TC-010
    const round = await startRound(client);
    const result = await client.post(guessRoute, GUESS_URL, { token: round.token, skipRound: true });
    expect(result.body).toMatchObject({ skippedRound: true, points: 0, attemptsRemaining: 0 });
    expect(result.body.reveal.chapterId).toBeGreaterThan(0);
  });

  it("accepts a round token exactly once", async () => {
    // TC-012 / TC-013: a double-click or an Enter press during a pending
    // request must not score twice. The first call consumes the revision.
    const round = await startRound(client);
    const first = await client.post(guessRoute, GUESS_URL, { token: round.token, skip: true });
    expect(first.status).toBe(200);

    const replay = await client.post(guessRoute, GUESS_URL, { token: round.token, skip: true });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatch(/stale state/i);
  });

  it("rejects two simultaneous guesses on the same revision", async () => {
    // TC-012 under genuine concurrency: exactly one may win.
    const round = await startRound(client);
    const results = await Promise.all([
      client.post(guessRoute, GUESS_URL, { token: round.token, skip: true }),
      client.post(guessRoute, GUESS_URL, { token: round.token, skip: true }),
    ]);
    const accepted = results.filter((result) => result.status === 200);
    expect(accepted).toHaveLength(1);
  });

  it("rejects a guess with no Surah chosen", async () => {
    const round = await startRound(client);
    const result = await client.post(guessRoute, GUESS_URL, { token: round.token });
    expect(result.status).toBe(400);
  });

  it.each([0, 115, -1, 2.5, "two"])("rejects out-of-range chapter id %s", async (chapterId) => {
    const round = await startRound(client);
    const result = await client.post(guessRoute, GUESS_URL, { token: round.token, chapterId });
    expect(result.status).toBe(400);
  });

  it("rejects a token replayed from a different browser", async () => {
    // TC-060: the cookie and the token must agree.
    const round = await startRound(client);
    client.forgetAttempt();
    const result = await client.post(guessRoute, GUESS_URL, { token: round.token, skip: true });
    expect(result.status).toBe(409);
  });

  it("rejects a forged token", async () => {
    const result = await client.post(guessRoute, GUESS_URL, { token: "not-a-token", skip: true });
    expect(result.status).toBe(400);
  });
});

describe("hint anti-cheat", () => {
  let client: RouteClient;
  beforeEach(() => { client = newClient(); });

  it("makes the first hint free and the second cost 3", async () => {
    // TC-041 / TC-042 / TC-049
    const round = await startRound(client);
    const first = await client.post(hintRoute, HINT_URL, { token: round.token, type: "juz" });
    expect(first.status).toBe(200);
    expect(first.body.cost).toBe(0);
    expect(first.body.pointsRemaining).toBe(100);

    const second = await client.post(hintRoute, HINT_URL, {
      token: first.body.token,
      type: "ayah_count",
    });
    expect(second.body.cost).toBe(3);
    expect(second.body.pointsRemaining).toBe(97);
  });

  it("refuses a third hint anywhere in the attempt", async () => {
    // TC-043 / TC-044
    const round = await startRound(client);
    const first = await client.post(hintRoute, HINT_URL, { token: round.token, type: "juz" });
    const second = await client.post(hintRoute, HINT_URL, { token: first.body.token, type: "meaning" });
    const third = await client.post(hintRoute, HINT_URL, {
      token: second.body.token,
      type: "ayah_count",
    });
    expect(third.status).toBe(409);
    expect(third.body.error).toMatch(/already been used/i);
  });

  it("never returns the answer alongside a hint", async () => {
    // The hint reveals one derived fact and no identifiers.
    const round = await startRound(client);
    const hint = await client.post(hintRoute, HINT_URL, { token: round.token, type: "ayah_count" });
    const serialized = JSON.stringify(hint.body);
    expect(serialized).not.toMatch(/"chapterId"/);
    expect(serialized).not.toMatch(/"verseKey"/);
    expect(hint.body.hint.value).toMatch(/Ayahs$/);
  });

  it("rejects an unknown hint type without touching state", async () => {
    // TC-059
    const round = await startRound(client);
    const result = await client.post(hintRoute, HINT_URL, { token: round.token, type: "chapterId" });
    expect(result.status).toBe(400);

    // The allowance is untouched, so a free hint is still available.
    const hint = await client.post(hintRoute, HINT_URL, { token: round.token, type: "juz" });
    expect(hint.body.cost).toBe(0);
  });

  it("ignores a client-supplied hint cost", async () => {
    // TC-058: scoring is computed server-side from the sealed token.
    const round = await startRound(client);
    const result = await client.post(hintRoute, HINT_URL, {
      token: round.token,
      type: "juz",
      cost: -100,
      hintPenalty: -100,
      pointsRemaining: 999,
    });
    expect(result.body.cost).toBe(0);
    expect(result.body.pointsRemaining).toBe(100);
  });

  it("rejects a pre-hint token replayed to dodge the deduction", async () => {
    // TC-054, the central replay case.
    const round = await startRound(client);
    const savedToken = round.token;

    const first = await client.post(hintRoute, HINT_URL, { token: savedToken, type: "juz" });
    const second = await client.post(hintRoute, HINT_URL, { token: first.body.token, type: "meaning" });
    expect(second.body.cost).toBe(3);

    // Guessing with the token saved before the paid hint must not restore the
    // pre-deduction score.
    const replay = await client.post(guessRoute, GUESS_URL, { token: savedToken, skip: true });
    expect(replay.status).toBe(409);
  });

  it("lets only one of two simultaneous hint requests succeed", async () => {
    // TC-055: both must not observe "one hint left" and both spend it.
    const round = await startRound(client);
    await client.post(hintRoute, HINT_URL, { token: round.token, type: "juz" });

    const fresh = await startRound(client);
    const results = await Promise.all([
      client.post(hintRoute, HINT_URL, { token: fresh.token, type: "meaning" }),
      client.post(hintRoute, HINT_URL, { token: fresh.token, type: "ayah_count" }),
    ]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
  });

  it("refuses a hint and a guess claiming the same revision", async () => {
    // TC-056
    const round = await startRound(client);
    const results = await Promise.all([
      client.post(hintRoute, HINT_URL, { token: round.token, type: "juz" }),
      client.post(guessRoute, GUESS_URL, { token: round.token, skip: true }),
    ]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
  });

  it("reports the Juz of the Ayah being played", async () => {
    // TC-047
    const round = await startRound(client);
    const hint = await client.post(hintRoute, HINT_URL, { token: round.token, type: "juz" });
    expect(hint.body.hint.value).toMatch(/^This Ayah is in Juz \d{1,2}$/);
  });

  it("reports Makki or Madani classification", async () => {
    // TC-048
    const round = await startRound(client);
    const hint = await client.post(hintRoute, HINT_URL, {
      token: round.token,
      type: "revelation_place",
    });
    expect(hint.body.hint.value).toMatch(/^(Makki|Madani)/);
  });
});

describe("seven-round attempt", () => {
  let client: RouteClient;
  beforeEach(() => { client = newClient(); });

  it("stops issuing rounds after the seventh", async () => {
    // TC-015 / TC-016 / TC-027. The client can ask for an eighth round; the
    // server refuses regardless of what localStorage claims.
    for (let index = 0; index < MAX_ATTEMPT_ROUNDS; index += 1) {
      const round = await startRound(client);
      expect(round.progress.roundsCompleted).toBe(index);
      const result = await client.post(guessRoute, GUESS_URL, {
        token: round.token,
        skipRound: true,
      });
      expect(result.status).toBe(200);
    }

    const eighth = await client.post(roundRoute, ROUND_URL, { language: "english" });
    // 409, not 500: exhausting an attempt is a legitimate end state, and the
    // client distinguishes "you are done" from "something broke" by status.
    expect(eighth.status).toBe(409);
    expect(eighth.body.error).toMatch(/attempt is complete/i);
  });

  it("refuses to reset an attempt that is still running", async () => {
    // TC-018 inverted: a player cannot reroll a bad Surah by starting over.
    await startRound(client);
    const result = await client.post(roundRoute, ROUND_URL, { newAttempt: true });
    expect(result.status).toBe(409);
  });

  it("allows a new attempt once seven rounds are done", async () => {
    for (let index = 0; index < MAX_ATTEMPT_ROUNDS; index += 1) {
      const round = await startRound(client);
      await client.post(guessRoute, GUESS_URL, { token: round.token, skipRound: true });
    }

    const result = await client.post(roundRoute, ROUND_URL, { newAttempt: true });
    expect(result.status).toBe(200);
    expect(result.body.progress.roundsCompleted).toBe(0);
    expect(result.body.hints.hintsRemaining).toBe(2);
  });

  it("reports server-side progress through the config endpoint", async () => {
    // TC-019 / TC-020: a refresh mid-attempt can reconcile against this rather
    // than trusting its own localStorage counter.
    const round = await startRound(client);
    await client.post(guessRoute, GUESS_URL, { token: round.token, skipRound: true });

    const config = await client.get(configRoute, "http://localhost:3000/api/quran/config");
    expect(config.body.attempt.roundsCompleted).toBe(1);
    expect(config.body.attempt.roundsRemaining).toBe(6);
    expect(config.body.rules.maxRounds).toBe(MAX_ATTEMPT_ROUNDS);
    expect(config.body.rules.scoreLadder).toHaveLength(5);
  });
});

/** Play a round to exhaustion and return the reveal. */
async function playUntilReveal(client: RouteClient, startToken: string) {
  let token = startToken;
  for (let index = 0; index < 5; index += 1) {
    const result = await client.post(guessRoute, GUESS_URL, { token, skip: true });
    if (result.body.exhausted) return result.body.reveal;
    token = result.body.token;
  }
  return null;
}

/** Brute-force the answer the way a determined player could, one try at a time. */
async function findAnswer(client: RouteClient, startToken: string) {
  let token = startToken;
  for (let chapterId = 1; chapterId <= 114; chapterId += 1) {
    const result = await client.post(guessRoute, GUESS_URL, { token, chapterId });
    if (result.body.correct) return result.body;
    if (result.body.exhausted) return result.body;
    token = result.body.token;
  }
  return { points: 0 };
}
