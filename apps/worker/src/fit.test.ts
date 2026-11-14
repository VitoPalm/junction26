import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { FIXTURES, validateDefinition } from '@junction26/applet-format';
import { checkRenderedFit } from './fit.ts';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { fitPrerequisites } from './fit.ts';
import { renderTutorialGifs } from './tutorial-video.ts';
const available =
  existsSync(new URL('../fit/check.js', import.meta.url)) &&
  ['/usr/bin/google-chrome-stable', '/usr/bin/chromium', process.env.CHROME_PATH ?? ''].some(existsSync);
test(
  'canonical rendering accepts fixtures and rejects an oversized readout',
  { skip: available ? false : 'Build fit bundle and install Chromium to measure layout' },
  async () => {
    const parsed = validateDefinition(FIXTURES.rowCounter);
    assert.ok(parsed.ok);
    assert.deepEqual(await checkRenderedFit(parsed.definition), []);
    parsed.definition.state[0]!.default = 123456789012345;
    const issues = await checkRenderedFit(parsed.definition);
    assert.ok(issues.some((i) => i.code === 'measured_fit'));
  },
);

test('GIF pages fit, keep the animated source, have no player controls and release hidden images',
  { skip: available ? false : 'Build fit bundle and install Chromium to check GIF rendering' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'j26-gif-render-'));
    const browser = await chromium.launch({ executablePath: fitPrerequisites(), headless: true, args: ['--no-sandbox'] });
    try {
      const input = join(dir, 'source.mp4');
      await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=2', '-c:v', 'mpeg4', '-threads', '1', input]);
      await renderTutorialGifs(input, { clips: [{ id: 'demo', start: 0, end: 2, label: 'Movement' }] }, dir);
      const parsed = validateDefinition({ formatVersion: 1, minimumRuntimeVersion: '0.2.0', title: 'Motion', toolPrefix: 'motion', state: [], actions: [], views: [{ id: 'loop', kind: 'image', asset: 'demo', alt: 'Movement' }], assets: [{ id: 'demo', mediaType: 'image/gif', data: (await readFile(join(dir, 'demo.gif'))).toString('base64') }] });
      assert.ok(parsed.ok);
      assert.deepEqual(await checkRenderedFit(parsed.definition), []);
      const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
      await page.route('**/*', r => r.request().isNavigationRequest() ? r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : r.abort());
      await page.goto('http://fit.invalid');
      await page.addStyleTag({ content: await readFile(new URL('../fit/check.css', import.meta.url), 'utf8') });
      await page.addScriptTag({ content: await readFile(new URL('../fit/check.js', import.meta.url), 'utf8') });
      await page.evaluate(def => (globalThis as any).renderFit(def, { kind: 'view', viewId: 'loop' }), parsed.definition);
      await page.waitForFunction('document.images[0]?.complete && document.images[0].naturalWidth > 0');
      assert.match((await page.locator('img').getAttribute('src'))!, /^data:image\/gif;base64,/);
      assert.equal(await page.locator('img').getAttribute('data-src'), null, 'must bypass static inkify');
      assert.equal(await page.getByRole('button').count(), 0);
      await page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));");
      await page.waitForFunction('document.images.length === 0');
      await page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));");
      await page.waitForFunction('document.images.length === 1');
      const sequence = structuredClone(parsed.definition);
      sequence.state = [{ id: 'position', type: 'cursor', label: 'Position', over: 'guide', default: 0 }];
      sequence.views = [{ id: 'guide', kind: 'sequence', cursor: 'position', steps: [{ id: 'stitch', image: 'demo', alt: 'Movement' }] }];
      assert.deepEqual(await checkRenderedFit(sequence), []);
      await renderTutorialGifs(input, { clips: [{ id: 'later', start: 1, end: 2, label: 'Later movement' }] }, dir);
      sequence.assets.push({ id: 'later', mediaType: 'image/gif', data: (await readFile(join(dir, 'later.gif'))).toString('base64') });
      sequence.views[0] = { id: 'guide', kind: 'sequence', cursor: 'position', steps: [
        { id: 'first', image: 'demo', alt: 'First movement', text: 'Make 3 treble crochets.' },
        { id: 'second', image: 'later', alt: 'Second movement', text: 'Make 3 double crochets.' },
        { id: 'finish', text: 'Weave in the ends.' },
      ] };
      assert.deepEqual(await checkRenderedFit(sequence), []);
      await page.evaluate(def => (globalThis as any).renderInteractiveFit(def), sequence);
      await page.getByText('Make 3 treble crochets.', { exact: true }).waitFor();
      const firstSource = await page.locator('[data-g-gif] img').getAttribute('src');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByText('Make 3 double crochets.', { exact: true }).waitFor();
      assert.notEqual(await page.locator('[data-g-gif] img').getAttribute('src'), firstSource);
      assert.equal(await page.locator('[data-g-gif]').count(), 1, 'only current step decodes a GIF');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByText('Weave in the ends.', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-g-gif]').count(), 0);
      await page.getByRole('button', { name: 'Previous', exact: true }).click();
      await page.getByText('Make 3 double crochets.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button').count(), 2, 'navigation only, no player controls');
      const broken = structuredClone(parsed.definition);
      broken.assets[0]!.data = Buffer.from('invalid gif bytes').toString('base64');
      assert.ok((await checkRenderedFit(broken)).some(i => i.code === 'image_decode'));
    } finally { await browser.close(); await rm(dir, { recursive: true, force: true }); }
  });
