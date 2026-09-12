import { type Locator, type Page, expect } from "@playwright/test";

/**
 * Page object for the SurahSpot board.
 *
 * The specs describe what a player does; the selectors live here. When the
 * markup changes, one file changes rather than every test — which is the only
 * way an e2e suite survives a UI iteration, and this app is expected to get
 * several.
 */
export class GamePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // --- Locators -----------------------------------------------------------

  get answerInput(): Locator {
    return this.page.getByPlaceholder("Type a Surah name…");
  }

  get guessButton(): Locator {
    return this.page.getByRole("button", { name: /^Guess/ });
  }

  get skipTryButton(): Locator {
    return this.page.getByRole("button", { name: /Skip this try/i });
  }

  get skipRoundButton(): Locator {
    return this.page.getByRole("button", { name: /Skip round/i });
  }

  get hintButton(): Locator {
    return this.page.getByRole("button", { name: /^Hint/ });
  }

  get playButton(): Locator {
    return this.page.getByRole("button", { name: /(Play|Pause) recitation/ });
  }

  get suggestions(): Locator {
    return this.page.locator("#surah-search-results");
  }

  get arabicText(): Locator {
    return this.page.locator(".arabic-text");
  }

  get pointsChip(): Locator {
    return this.page.locator(".points-chip b");
  }

  get roundLabel(): Locator {
    return this.page.locator(".round-meta");
  }

  get feedback(): Locator {
    return this.page.locator(".feedback");
  }

  get revealCard(): Locator {
    return this.page.locator(".reveal-card");
  }

  get summaryDialog(): Locator {
    return this.page.getByRole("dialog", { name: /attempt summary|Your attempt/i });
  }

  get usedTries(): Locator {
    return this.page.locator(".tries .used");
  }

  // --- Actions ------------------------------------------------------------

  async goto() {
    await this.page.goto("/");
    await this.waitForRound();
  }

  /** Wait until a round is actually playable, not merely painted. */
  async waitForRound() {
    await expect(this.arabicText.locator(".quran-word").first()).toBeVisible({ timeout: 30_000 });
    await expect(this.guessButton).toBeEnabled();
  }

  async search(term: string) {
    await this.answerInput.click();
    await this.answerInput.fill(term);
  }

  async chooseSurah(name: string) {
    await this.search(name);
    await this.suggestions.getByRole("button").filter({ hasText: name }).first().click();
  }

  async guess(name: string) {
    await this.chooseSurah(name);
    await this.guessButton.click();
  }

  async skipTry() {
    const before = await this.usedTries.count();
    await this.skipTryButton.click();
    await expect(this.usedTries).toHaveCount(before + 1);
  }

  /** Skip the whole round and wait for whatever comes next. */
  async skipRound() {
    await this.skipRoundButton.click();
  }

  async openHintMenu() {
    await this.hintButton.click();
    await expect(this.page.getByRole("group", { name: /Choose a hint/i })).toBeVisible();
  }

  async takeHint(label: RegExp) {
    await this.openHintMenu();
    await this.page.getByRole("button", { name: label }).click();
  }

  get revealedHints(): Locator {
    return this.page.locator(".hint-reveal");
  }

  /** Current points shown on the board. */
  async points() {
    return Number((await this.pointsChip.textContent())?.trim());
  }

  /** Play a whole round out by skipping every try. Returns the revealed Surah. */
  async exhaustRound() {
    for (let index = 0; index < 5; index += 1) {
      if (await this.revealCard.isVisible()) break;
      await this.skipTryButton.click();
      await this.page.waitForTimeout(150);
    }
    await expect(this.revealCard).toBeVisible();
    return (await this.revealCard.locator("h2").textContent())?.trim() ?? "";
  }

  async nextRound() {
    await this.page.getByRole("button", { name: /Next Ayah/i }).click();
    await this.waitForRound();
  }
}
