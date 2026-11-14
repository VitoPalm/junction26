import { test, expect } from '@playwright/test';
for (const size of [600, 480]) {
  for (const variant of ['140', '160']) {
    test(`${variant} image guide fits at ${size} and preserves position`, async ({ page }) => {
      await page.setViewportSize({ width: size, height: size });
      await page.goto('http://127.0.0.1:4182/');
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.getByRole('button', { name: `${variant} cm tabletop`, exact: true }).click();
      for (let i = 0; i < 13; i++) {
        const image = page.locator('.g-diagram');
        await expect(image).toBeVisible();
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.locator('.g-content p')).toHaveCount(0);
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => {
          const r = element.getBoundingClientRect();
          const v = document.querySelector('.g-viewport')!.getBoundingClientRect();
          return element.complete && element.naturalWidth > 0 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1 && r.left >= v.left - 1 && r.right <= v.right + 1;
        })).toBe(true);
        await page.mouse.move(size / 2, size / 2);
        await page.mouse.wheel(0, 800);
        expect(await page.evaluate(() => [window.scrollY, document.querySelector('.g-viewport')!.scrollTop])).toEqual([0, 0]);
        if (i === 1) {
          const src = await image.getAttribute('data-src');
          await page.reload();
          await expect(page.locator('.g-diagram')).toHaveAttribute('data-src', src!);
        }
        if (i < 12) {
          await page.getByRole('button', { name: 'Next', exact: true }).click();
          await page.waitForTimeout(40);
        }
      }
      await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();
    });
  }
}
