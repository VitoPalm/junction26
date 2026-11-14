import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { AppletDefinition, Issue } from '@junction26/applet-format';

export function fitPrerequisites(): string {
  const executablePath =
    process.env.CHROME_PATH ??
    ['/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
  if (!executablePath || !existsSync(executablePath))
    throw new Error('Chromium is required for generation fit checks (set CHROME_PATH).');
  if (
    !existsSync(new URL('../fit/check.js', import.meta.url)) ||
    !existsSync(new URL('../fit/check.css', import.meta.url))
  )
    throw new Error('Build the generation fit bundle with npm run build:fit -w @junction26/worker.');
  return executablePath;
}

type ScreenInput = { kind: 'menu' } | { kind: 'view'; viewId: string };

/** Canonical renderer in headless Chromium at 600×600. Simulator evidence, not hardware verification. */
export async function checkRenderedFit(def: AppletDefinition, signal?: AbortSignal): Promise<Issue[]> {
  const executablePath = fitPrerequisites();
  const [script, css] = await Promise.all([
    readFile(new URL('../fit/check.js', import.meta.url), 'utf8'),
    readFile(new URL('../fit/check.css', import.meta.url), 'utf8'),
  ]);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const deadline = setTimeout(() => {
    void browser.close();
  }, 45000);
  const abort = () => {
    void browser.close();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const page = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(5000);
    // Source assets are data URLs. No page can make network requests during this check.
    await page.route('**/*', (route) =>
      route.request().isNavigationRequest()
        ? route.fulfill({
            contentType: 'text/html',
            body: '<html><head></head><body><div id="root"></div></body></html>',
          })
        : route.abort(),
    );
    await page.goto('http://fit.invalid/');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: script });
    const issues: Issue[] = [];
    const inspect = async (
      screen: { kind: 'menu' } | { kind: 'view'; viewId: string },
      path: string,
      cursor = 0,
      listPage = 0,
    ) => {
      signal?.throwIfAborted();
      await page.evaluate(
        ({ def, screen, cursor, listPage }) =>
          (
            globalThis as unknown as { renderFit: (def: AppletDefinition, screen: ScreenInput, cursor: number) => void }
          ).renderFit(def, screen, cursor),
        { def, screen, cursor, listPage },
      );
      for (let p = 0; p < listPage; p++) await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await page.evaluate(`(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      const failed =
        (await page.locator('.g-fit-error').count()) ||
        (await page.getByText("Can't show this page", { exact: true }).count());
      if (failed)
        issues.push({
          path,
          code: 'measured_fit',
          message:
            'Canonical renderer at 600×600 reports a fit error. Split this page, shorten redundant copy, or remove redundant titles/hints; preserve source facts.',
        });
      const badImage = await page
        .locator('img')
        .evaluateAll((images) => images.some((i) => !(i as unknown as { naturalWidth: number }).naturalWidth));
      if (badImage || await page.locator('[data-g-gif-error]').count())
        issues.push({
          path,
          code: 'image_decode',
          message: 'An image does not decode. Use a supplied source image ref.',
        });
    };
    if (def.views.length > 1)
      for (let p = 0; p < Math.ceil(def.views.length / 3); p++)
        await inspect({ kind: 'menu' }, `views.menu (page ${p + 1})`, 0, p);
    for (const [i, v] of def.views.entries()) {
      const pages =
        v.kind === 'sequence'
          ? v.steps.length
          : v.kind === 'list'
            ? Math.max(
                1,
                Math.ceil((def.state.find((f) => f.id === v.field) as { default: unknown[] }).default.length / 3),
              )
            : 1;
      for (let p = 0; p < pages; p++)
        await inspect(
          { kind: 'view', viewId: v.id },
          v.kind === 'sequence' ? `views[${i}].steps[${p}]` : `views[${i}] (page ${p + 1})`,
          v.kind === 'sequence' ? p : 0,
          v.kind === 'list' ? p : 0,
        );
    }
    return issues;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    await browser.close();
  }
}
