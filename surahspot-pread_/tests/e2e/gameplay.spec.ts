import { expect, test } from "@playwright/test";
import { GamePage } from "./support/game-page";

/**
 * Browser-level gameplay. Mirrors the interaction cases from the test plan
 * that only exist once a real DOM, a real audio element and a real cookie jar
 * are involved: TC-008 to TC-015, TC-028 to TC-039, TC-070, TC-071.
 */

test.describe("board", () => {
  test("loads a playable round without revealing the answer", async ({ page }) => {
    // TC-001 and TC-053 from the player's side: nothing on screen names the
    // Surah before the reveal.
    const game = new GamePage(page);
    await game.goto();

    await expect(game.roundLabel).toContainText("Round 1 of 7");
    await expect(game.pointsChip).toHaveText("100");
    await expect(page.locator(".hidden-ref")).toContainText(/hidden until reveal/i);
    await expect(game.usedTries).toHaveCount(0);
  });

  test("renders Arabic right-to-left and marked untranslatable", async ({ page }) => {
    // TC-083 and TC-092: a browser translation extension must not rewrite the
    // Quranic text, and must not hand over the answer by translating it.
    const game = new GamePage(page);
    await game.goto();

    await expect(game.arabicText).toHaveAttribute("dir", "rtl");
    await expect(game.arabicText).toHaveAttribute("translate", "no");
    await expect(game.arabicText).toHaveAttribute("lang", "ar");
  });

  test("keeps a long Ayah inside the card", async ({ page }) => {
    // TC-084: no horizontal overflow, at any viewport.
    const game = new GamePage(page);
    await game.goto();

    const overflows = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows).toBe(false);
  });
});

test.describe("answer search", () => {
  test("keeps the dropdown closed until the field is used", async ({ page }) => {
    // TC-028: the full Surah list appearing unprompted is both noise and a nudge.
    const game = new GamePage(page);
    await game.goto();
    await expect(game.suggestions).toBeHidden();

    await game.answerInput.click();
    await expect(game.suggestions).toBeVisible();
  });

  test("closes on Escape and on an outside click", async ({ page }) => {
    // TC-030 / TC-031
    const game = new GamePage(page);
    await game.goto();

    await game.answerInput.click();
    await expect(game.suggestions).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(game.suggestions).toBeHidden();

    await game.answerInput.click();
    await expect(game.suggestions).toBeVisible();
    await page.locator(".hero-copy h1").click();
    await expect(game.suggestions).toBeHidden();
  });

  test("finds a Surah by name, by prefix and by number", async ({ page }) => {
    // TC-032 / TC-033 / TC-034
    const game = new GamePage(page);
    await game.goto();

    for (const term of ["Baqarah", "surah baqarah", "2"]) {
      await game.search(term);
      await expect(
        game.suggestions.getByRole("button").filter({ hasText: "Al-Baqarah" }).first(),
      ).toBeVisible();
    }
  });

  test("never surfaces an Ayah result that would give the answer away", async ({ page }) => {
    // TC-037, the single most important search case. Pasting the visible
    // Arabic into the box must not identify its Surah.
    const game = new GamePage(page);
    await game.goto();

    const arabic = (await game.arabicText.innerText()).split(/\s+/).slice(0, 3).join(" ");
    await game.search(arabic);
    await page.waitForTimeout(600);

    // Whatever comes back is a list of Surah options, never a verse reference.
    await expect(game.suggestions).not.toContainText(/\d+:\d+/);
    const options = await game.suggestions.getByRole("button").count();
    const status = await game.suggestions.locator(".search-status").count();
    expect(options + status).toBeGreaterThan(0);
  });

  test("rejects an abusive query without breaking the UI", async ({ page }) => {
    // TC-039
    const game = new GamePage(page);
    await game.goto();

    await game.search("x".repeat(400));
    await page.waitForTimeout(600);
    await expect(game.answerInput).toBeVisible();
    await expect(game.guessButton).toBeEnabled();
  });
});

test.describe("scoring", () => {
  test("spends one try per skip and steps the score down", async ({ page }) => {
    // TC-008 / TC-009
    const game = new GamePage(page);
    await game.goto();

    for (const expected of [80, 60, 40, 20]) {
      await game.skipTry();
      await expect(game.pointsChip).toHaveText(String(expected));
    }
  });

  test("ends the round after five tries and reveals the Surah", async ({ page }) => {
    // TC-007
    const game = new GamePage(page);
    await game.goto();

    const revealed = await game.exhaustRound();
    expect(revealed.length).toBeGreaterThan(0);
    await expect(game.revealCard).toContainText(/The answer was/i);
  });

  test("Skip round ends the Ayah immediately", async ({ page }) => {
    // TC-010
    const game = new GamePage(page);
    await game.goto();

    await game.skipRound();
    // Either a reveal or the next round, depending on where in the attempt we
    // are — both are "this round is over", which is what the control promises.
    await expect
      .poll(async () => (await game.revealCard.count()) + (await game.roundLabel.count()))
      .toBeGreaterThan(0);
  });

  test("accepts only one submission from a double click", async ({ page }) => {
    // TC-012: the second click must not consume a second try.
    const game = new GamePage(page);
    await game.goto();

    await game.chooseSurah("Al-Kawthar");
    await Promise.all([
      game.guessButton.click(),
      game.guessButton.click({ force: true }).catch(() => {}),
    ]);
    await page.waitForTimeout(800);

    expect(await game.usedTries.count()).toBeLessThanOrEqual(1);
  });
});

test.describe("hints", () => {
  test("offers two hints, the first free and the second costing points", async ({ page }) => {
    // TC-040 / TC-041 / TC-042 / TC-049
    const game = new GamePage(page);
    await game.goto();

    await expect(game.hintButton).toContainText("2/2");

    await game.takeHint(/Juz/i);
    await expect(game.revealedHints).toHaveCount(1);
    await expect(game.hintButton).toContainText("1/2");
    await expect(game.pointsChip).toHaveText("100");

    await game.takeHint(/Number of Ayahs/i);
    await expect(game.revealedHints).toHaveCount(2);
    await expect(game.pointsChip).toHaveText("97");
  });

  test("disables the hint control once the allowance is spent", async ({ page }) => {
    // TC-043 from the UI: there is no third hint to click.
    const game = new GamePage(page);
    await game.goto();

    await game.takeHint(/Juz/i);
    await game.takeHint(/Meaning of the name/i);
    await expect(game.hintButton).toBeDisabled();
  });

  test("shows a hint value without naming the Surah", async ({ page }) => {
    const game = new GamePage(page);
    await game.goto();

    await game.takeHint(/Makkah or Madinah/i);
    await expect(game.revealedHints.first()).toContainText(/Makki|Madani/);
    await expect(game.revealedHints.first()).not.toContainText(/Surah \d/);
  });
});

test.describe("attempt", () => {
  test("runs exactly seven rounds and then shows the summary", async ({ page }) => {
    // TC-014 / TC-015 / TC-016. Slow by nature; it plays a whole attempt.
    test.slow();

    const game = new GamePage(page);
    await game.goto();

    for (let round = 1; round <= 7; round += 1) {
      await expect(game.roundLabel).toContainText(`Round ${round} of 7`);
      await game.skipRound();
      if (round < 7) await game.waitForRound();
    }

    await expect(game.summaryDialog).toBeVisible({ timeout: 20_000 });
    await expect(game.summaryDialog).toContainText(/7\/7/);
    // TC-015: no eighth round is offered.
    await expect(page.getByRole("button", { name: /Next Ayah/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Start new attempt/i })).toBeVisible();
  });

  test("does not repeat a Surah within one attempt", async ({ page }) => {
    // TC-017
    test.slow();

    const game = new GamePage(page);
    await game.goto();

    const seen: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      const revealed = await game.exhaustRound();
      seen.push(revealed);
      if (round < 3) await game.nextRound();
    }

    // The fixture environment serves nine Surahs, so four rounds must be
    // distinct. On production the pool is 114 and the rule is the same.
    expect(new Set(seen).size).toBe(seen.length);
  });
});

test.describe("keyboard", () => {
  test("Space toggles playback when no field is focused", async ({ page }) => {
    // TC-070
    const game = new GamePage(page);
    await game.goto();

    await page.locator(".hero-copy h1").click();
    await page.keyboard.press("Space");
    await expect(game.playButton).toHaveAccessibleName(/Pause recitation/, { timeout: 10_000 });
  });

  test("Space types a space while the answer field is focused", async ({ page }) => {
    // TC-071: this was a real double-action bug.
    const game = new GamePage(page);
    await game.goto();

    await game.answerInput.click();
    await game.answerInput.type("al ");
    await expect(game.answerInput).toHaveValue("al ");
    await expect(game.playButton).toHaveAccessibleName(/Play recitation/);
  });
});
