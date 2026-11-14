/** Free interactive QA and standalone preview for a generated GIF guide. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { validateDefinition } from '@junction26/applet-format';
import { checkRenderedFit, fitPrerequisites } from '../../apps/worker/src/fit.ts';

const path = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Supply a generated definition.json');
const parsed = validateDefinition(JSON.parse(await readFile(path, 'utf8')));
assert.ok(parsed.ok, JSON.stringify(parsed.issues));
const def = parsed.definition;
const guide = def.views.find(v => v.kind === 'sequence'); assert.ok(guide?.kind === 'sequence');
assert.deepEqual(await checkRenderedFit(def), []);
const script = await readFile(new URL('../../apps/worker/fit/check.js', import.meta.url));
const css = await readFile(new URL('../../apps/worker/fit/check.css', import.meta.url));
const target = dirname(path);
const safeDef = JSON.stringify(def).replace(/</g, '\\u003c');
// The toolkit otherwise injects a Google Fonts stylesheet even for embedded assets.
// Own its font marker in this offline fixture and use the same local/system fallback.
const localFonts = [400, 500, 700].map(weight => `@font-face{font-family:'Noto Sans Local';font-style:normal;font-weight:${weight};src:local('Noto Sans${weight === 500 ? ' Medium' : weight === 700 ? ' Bold' : ''}');}`).join('');
// Everything is embedded: no server, credentials, model API or external assets.
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crochet heart applet preview</title><style id="uit-noto-sans-font">${localFonts}</style><style>${css.toString()}</style></head><body><div id="root"></div><script src="data:text/javascript;base64,${script.toString('base64')}"></script><script>renderInteractiveFit(${safeDef});</script></body></html>`;
await writeFile(join(target, 'preview.html'), html);
const shots = join(target, 'screenshots'); await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: fitPrerequisites(), headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  let networkRequests = 0;
  const requested: string[] = [];
  await page.route('**/*', route => {
    if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: html });
    networkRequests++; requested.push(route.request().url()); return route.abort();
  });
  await page.goto('http://video-guide.invalid');
  await page.evaluate('document.fonts.ready');
  let gifSteps = 0;
  const seen = [];
  for (const [index, step] of guide.steps.entries()) {
    if (step.title) await page.getByText(step.title, { exact: true }).waitFor();
    if (step.text) await page.getByText(step.text, { exact: true }).waitFor();
    const asset = step.image ? def.assets.find(a => a.id === step.image) : undefined;
    if (asset?.mediaType === 'image/gif') {
      gifSteps++;
      await page.locator('[data-g-gif] img').waitFor();
      await page.waitForFunction('document.images[0]?.complete && document.images[0].naturalWidth > 0');
      assert.equal(await page.locator('[data-g-gif] img').getAttribute('src'), `data:image/gif;base64,${asset.data}`);
      assert.equal(await page.locator('[data-g-gif]').count(), 1);
      await page.screenshot({ path: join(shots, `${String(index).padStart(2, '0')}-${step.id}.png`) });
    } else assert.equal(await page.locator('[data-g-gif]').count(), 0);
    assert.equal(await page.locator('.g-fit-error,[data-g-gif-error]').count(), 0);
    assert.equal(await page.getByRole('button').count(), 2, 'only Previous/Next, no playback controls');
    seen.push(step.id);
    if (index < guide.steps.length - 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
  }
  assert.ok(await page.getByRole('button', { name: 'Next', exact: true }).isDisabled());
  await page.screenshot({ path: join(shots, 'complete.png') });
  for (let i = guide.steps.length - 2; i >= 0; i--) {
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    const step = guide.steps[i]!;
    if (step.title) await page.getByText(step.title, { exact: true }).waitFor();
    if (step.text) await page.getByText(step.text, { exact: true }).waitFor();
  }
  assert.ok(await page.getByRole('button', { name: 'Previous', exact: true }).isDisabled());
  assert.deepEqual(requested, []);
  const result = { passed: true, stepsForwardAndBack: seen, gifSteps, networkRequests, fit: '600x600 Chrome passed', preview: 'preview.html' };
  await writeFile(join(target, 'interactive-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
