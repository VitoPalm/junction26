/**
 * Renders the original fixture care labels (packages/laundry/src/fixtures/labels/*.png)
 * from LABEL_FIXTURES: printed text only, no symbol artwork. Rerun after editing
 * the fixtures: node --conditions=junction26-source scripts/laundry/make-labels.ts
 * (CHROME_PATH overrides the browser).
 */
import { chromium } from '@playwright/test';
import { LABEL_FIXTURES } from '@junction26/laundry';

const out = new URL('../../packages/laundry/src/fixtures/labels/', import.meta.url);
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable' });
const page = await browser.newPage({ viewport: { width: 360, height: 300 } });
for (const f of LABEL_FIXTURES) {
  const lines: { text: string; blur?: boolean }[] = [];
  if (f.info.fibers) lines.push({ text: f.info.fibers.map((x) => `${x.percent}% ${x.fiber.toUpperCase()}`).join(' / ') });
  for (const k of ['wash', 'bleach', 'dry', 'iron', 'professional'] as const) {
    const r = f.read[k];
    if (r.status === 'not_present') continue;
    if (k === 'wash' && f.id === 'striped_shirt') { lines.push({ text: 'MACHINE WASH 40°C' }, { text: 'HAND WASH ONLY' }); continue; }
    if (k === 'wash' && f.id === 'grey_hoodie') { lines.push({ text: 'MACHINE WASH WARM 40°C' }); continue; }
    if (k === 'wash' && r.status === 'unreadable') { lines.push({ text: 'MACHINE WASH 40°C', blur: true }); continue; }
    lines.push({ text: (r.source ?? '').toUpperCase() });
  }
  await page.setContent(`<body style="margin:0;background:#d9d4c7;display:grid;place-items:center;height:300px">
    <div style="background:#fbfaf6;width:260px;padding:18px 16px;font:600 15px/1.45 Helvetica,Arial,sans-serif;color:#222;letter-spacing:.04em;text-align:center;box-shadow:0 2px 6px #0003">
      ${lines.map((l) => `<div style="${l.blur ? 'filter:blur(3.2px)' : ''}">${esc(l.text)}</div>`).join('')}
      <div style="margin-top:10px;font-size:11px;color:#666">SAMPLE LABEL · JUNCTION26 FIXTURE</div>
    </div></body>`);
  await page.screenshot({ path: new URL(f.file, out).pathname });
}
await browser.close();
console.log(`wrote ${LABEL_FIXTURES.length} labels`);
