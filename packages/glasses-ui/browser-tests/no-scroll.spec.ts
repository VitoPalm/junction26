import { test, expect, type Page } from '@playwright/test';
async function fits(page: Page) {
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')].filter(e => {
    const c = getComputedStyle(e);
    return e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 &&
      ((['auto', 'scroll'].includes(c.overflowY) && e.scrollHeight > e.clientHeight + 1) ||
       (['auto', 'scroll'].includes(c.overflowX) && e.scrollWidth > e.clientWidth + 1));
  }).map(e => e.tagName + '.' + e.className))).toEqual([]);
  const before = await page.evaluate(() => [window.scrollX, window.scrollY, ...[...document.querySelectorAll('.g-viewport,.g-content')].flatMap(e => [e.scrollTop, e.scrollLeft])]);
  await page.mouse.move(300, 250);
  await page.mouse.wheel(0, 700);
  const after = await page.evaluate(() => [window.scrollX, window.scrollY, ...[...document.querySelectorAll('.g-viewport,.g-content')].flatMap(e => [e.scrollTop, e.scrollLeft])]);
  expect(after).toEqual(before);
}

test('library examples fit without a scrolling viewport', async ({ page }) => {
  await page.goto('http://127.0.0.1:4181/');
  await page.getByRole('button', { name: /Crochet guide/ }).waitFor();
  await fits(page);
  await page.getByRole('button', { name: /Crochet guide/ }).click();
  await expect(page.getByText('STEP 1 OF 3')).toBeVisible();
  await fits(page);
});

test('IKEA guide pages and fitted diagrams never require scrolling', async ({ page }) => {
  await page.goto('http://127.0.0.1:4180/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: /140 cm tabletop/ }).click();
  await expect(page.getByText(/VIEW 1 OF/)).toBeVisible();
  let checked = 0;
  while (checked++ < 80) {
    await fits(page);
    const next = page.getByRole('button', { name: 'Next', exact: true });
    if (!await next.count()) break;
    await next.click();
    // Toolkit keeps the same mounted controls as content changes.
    await page.waitForTimeout(50);
  }
  await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();
  expect(checked).toBeGreaterThan(20);
});

test('small supported viewport stays paged', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 480 });
  await page.goto('http://127.0.0.1:4180/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: /160 cm tabletop/ }).click();
  await expect(page.getByText(/VIEW 1 OF/)).toBeVisible();
  await fits(page);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await fits(page);
});

test('checklist changes pages instead of moving a scroll viewport', async ({ page }) => {
  await page.goto('http://127.0.0.1:4181/');
  await page.getByRole('button', { name: /Project supplies/ }).click();
  await expect(page.getByRole('button', { name: 'Yarn', exact: true })).toBeVisible();
  await fits(page);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Scissors', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yarn', exact: true })).toHaveCount(0);
  await fits(page);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Yarn', exact: true })).toBeVisible();
});

test('overflow becomes an explicit error instead of concealed or scrollable instructions', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 220 });
  await page.goto('http://127.0.0.1:4180/guide/top-140');
  await expect(page.getByRole('alert')).toContainText('This page does not fit');
  expect(await page.locator('.g-viewport').evaluate(e => getComputedStyle(e).overflowY)).toBe('clip');
});
