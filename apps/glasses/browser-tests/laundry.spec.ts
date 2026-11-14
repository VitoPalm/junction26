import { expect, test, type Page } from '@playwright/test';

// Laundry task module in the real glasses app at 600×600 (docs/laundry.md),
// using the bundled fixture session. Voice goes through the explicit dev
// WebMCP stub. Browser evidence only: no simulator, Meta AI or hardware.

type Result = Record<string, unknown> & { ok?: boolean; error?: string };
declare global {
  interface Window { webmcp: { list(): { name: string }[]; call(name: string, args?: Record<string, unknown>): Promise<Result> } }
}
const call = (page: Page, name: string, args: Record<string, unknown> = {}) => page.evaluate(([n, a]) => window.webmcp.call(`j26_laundry_${n}`, a as Record<string, unknown>), [name, args] as const);
const btn = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
/** Cards page long text (no scrolling): read through, then OK. */
async function closeCard(page: Page) {
  for (let i = 0; i < 5 && !(await btn(page, 'OK').isVisible()); i++) await btn(page, 'More').click();
  await btn(page, 'OK').click();
}
/** Lists show three choices per page (no scrolling): page forward until the choice is there. */
async function choose(page: Page, name: string) {
  for (let i = 0; i < 6 && !(await btn(page, name).isVisible()); i++) await btn(page, 'Next page').click();
  await btn(page, name).click();
}

async function noScroll(page: Page) {
  await page.mouse.wheel(0, 800);
  expect(await page.evaluate(() => [window.scrollY, document.scrollingElement!.scrollHeight <= window.innerHeight])).toEqual([0, true]);
  await expect(page.getByRole('alert')).toHaveCount(0);
}

async function open(page: Page) {
  await page.goto('/glasses/?webmcp');
  await page.evaluate(() => new Promise<void>((res) => { const r = indexedDB.deleteDatabase('junction26-glasses'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
  await page.goto('/glasses/?webmcp');
  await page.getByRole('button', { name: /Laundry: Sunday load/ }).click();
  await expect(page.getByText('Set aside for hand washing: Blue sweater')).toBeVisible();
}

test('one action at a time with D-pad, Show label, Explain, Undo and local answers', async ({ page }) => {
  await open(page);
  await noScroll(page);
  for (let i = 0; i < 8 && (await page.evaluate(() => document.activeElement?.textContent?.trim())) !== 'Confirm sorted'; i++) await page.keyboard.press(i < 4 ? 'ArrowDown' : 'ArrowRight');
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Confirm sorted');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Keep out of the wash, for professional cleaning: Silk blouse')).toBeVisible();

  // Show label (one garment on this step → straight to its label), offline and without AI.
  await btn(page, 'More').click();
  await btn(page, 'Show label').click();
  await expect(page.getByRole('heading', { name: 'Silk blouse label' })).toBeVisible();
  await expect(page.getByText(/Washing: Do not wash in water/)).toBeVisible();
  await noScroll(page);
  await closeCard(page);

  // Explain grouping.
  await btn(page, 'More').click();
  await btn(page, 'Explain grouping').click();
  await expect(page.getByText(/Dry clean only/)).toBeVisible();
  await btn(page, 'OK').click();

  // Undo the confirmation (second page of the menu: three choices per page).
  await btn(page, 'More').click();
  await btn(page, 'Next page').click();
  await btn(page, 'Undo').click();
  await expect(page.getByText(/Step 1 of/i)).toBeVisible();
  await expect(btn(page, 'Confirm sorted')).toBeVisible();

  // "Can these go together?" with the band.
  await btn(page, 'More').click();
  await btn(page, 'Ask a question').click();
  await btn(page, 'Can these go together?').click();
  await choose(page, 'Blue sweater');
  await choose(page, 'White towels');
  await expect(page.getByText('No, keep them apart')).toBeVisible();
  await expect(page.getByText(/Hand wash only, up to 30°C/)).toBeVisible();
  await closeCard(page);

  // Symbol meaning, local.
  expect((await call(page, 'symbol_meaning', { symbol: 'triangle with two lines' })).meaning).toMatch(/non-chlorine/);
  await closeCard(page);
});

test('voice commands are repeat-safe; a plan change after sorting needs confirmation and keeps progress', async ({ page }) => {
  await open(page);
  // Two identical voice confirmations at once still confirm a single step.
  await Promise.all([call(page, 'confirm_step'), call(page, 'confirm_step')]);
  const status = await call(page, 'laundry_status');
  expect((status.step as { number: number }).number).toBe(2);

  // Sort Group 1, then find the leggings' wash step.
  for (let i = 0; i < 30; i++) {
    const s = await call(page, 'laundry_status');
    if ((s.garments as string[]).includes('Gym leggings') && /Delicate/.test((s.step as { text: string }).text)) break;
    await call(page, (s.step as { confirmed: boolean }).confirmed ? 'next_step' : 'confirm_step');
  }
  await expect(page.getByText(/Delicate\/gentle, 30°C or lower/)).toBeVisible();
  const confirmedBefore = ((await call(page, 'laundry_status')).step as { number: number }).number;

  // "My washer doesn't have that cycle" → question → proposal → confirm.
  await btn(page, 'More').click();
  await btn(page, 'Next page').click();
  await btn(page, 'Report a change').click();
  await btn(page, 'Washer lacks this cycle').click();
  await btn(page, 'None of these').click();
  await expect(page.getByText('Proposed change')).toBeVisible();
  await expect(page.getByText(/Gym leggings: Group \d → hand/)).toBeVisible();
  await noScroll(page);
  await btn(page, 'Change plan').click();
  await expect(page.getByText('Proposed change')).toHaveCount(0); // shown only after the change is saved

  // Close and reopen: the adapted plan and earlier confirmations come back from IndexedDB.
  await page.goto('/glasses/?webmcp');
  await page.getByRole('button', { name: /Laundry: Sunday load/ }).click();
  await expect(page.getByText(/Step \d+ of/i)).toBeVisible();
  const hand = await call(page, 'why_separate', { garment: 'leggings' });
  expect(String(hand.explanation)).toMatch(/hand wash it/i);
  await closeCard(page);
  // The hand pile changed (leggings joined it), so it's the step to re-confirm;
  // confirmations of unchanged steps (e.g. professional cleaning) are kept.
  const reopened = await call(page, 'laundry_status');
  expect(reopened.step).toMatchObject({ number: 1, confirmed: false });
  expect(reopened.garments).toEqual(['Blue sweater', 'Gym leggings']);
  await call(page, 'next_step');
  expect(((await call(page, 'laundry_status')).step as { confirmed: boolean }).confirmed).toBe(true);
  expect(confirmedBefore).toBeGreaterThan(2);

  // "I already put the sweater in the machine": no rescue promised, keep plan.
  const r = await call(page, 'report_in_machine', { garment: 'sweater' });
  expect(r.question).toBe('Has the cycle with Blue sweater started?');
  const p = await call(page, 'choose_option', { option: 'running' });
  expect((p.details as string[]).join(' ')).toMatch(/can’t tell what the cycle will do/);
  expect((await call(page, 'decline_change')).ok).toBe(true);
  expect((await call(page, 'decline_change')).error).toBe('no_proposal');
  expect((await call(page, 'show_label', { garment: 'bath mat' })).error).toBe('unknown_garment');
});
