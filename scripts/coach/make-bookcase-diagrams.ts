/**
 * Renders the original step diagrams for the two-shelf bookcase fixture
 * (packages/applet-format/src/fixtures/bookcase-diagrams.ts): manual-style
 * dark line drawings on white, part letters only, no prose. The glasses re-ink
 * them for the additive display. Rerun after editing:
 *   node --conditions=junction26-source scripts/coach/make-bookcase-diagrams.ts
 * (CHROME_PATH overrides the browser).
 */
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const W = 480, H = 360;
const ink = 'stroke="#111" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"';
const thin = 'stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"';
const solid = 'fill="#111"';
const label = (x: number, y: number, t: string, size = 30) => `<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}" fill="#111" text-anchor="middle">${t}</text>`;
const arrow = (x1: number, y1: number, x2: number, y2: number) => {
  const a = Math.atan2(y2 - y1, x2 - x1), s = 16;
  const p = (d: number) => `${x2 - s * Math.cos(a + d)},${y2 - s * Math.sin(a + d)}`;
  return `<path ${ink} d="M${x1} ${y1} L${x2} ${y2}"/><path ${solid} d="M${x2} ${y2} L${p(0.45)} L${p(-0.45)} Z"/>`;
};
/** A board in simple oblique projection: front face w×h at (x,y), depth d up-right. */
const board = (x: number, y: number, w: number, h: number, d = 18) =>
  `<path ${ink} d="M${x} ${y} h${w} v${h} h${-w} Z M${x} ${y} l${d} ${-d} h${w} l${-d} ${d} M${x + w} ${y} l${d} ${-d} v${h} l${-d} ${d}"/>`;
const bolt = (x: number, y: number, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><path ${ink} d="M-10 -16 h20 v8 h-20 Z M-4 -8 v34 M4 -8 v34"/><path ${thin} d="M-4 2 l8 4 M-4 10 l8 4 M-4 18 l8 4"/></g>`;
const dowel = (x: number, y: number, s = 1, r = 0) => `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})"><rect ${ink} x="-6" y="-22" width="12" height="44" rx="5"/><path ${thin} d="M-6 -10 h12 M-6 0 h12 M-6 10 h12"/></g>`;
const camlock = (x: number, y: number, r = 22) => `<circle ${ink} cx="${x}" cy="${y}" r="${r}"/><path ${ink} d="M${x - r * 0.5} ${y} h${r} M${x} ${y - r * 0.5} v${r}"/><path ${solid} d="M${x + r * 0.15} ${y - r - 10} l12 6 l-12 6 Z"/>`;
const nail = (x: number, y: number, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><path ${ink} d="M-9 -14 h18 M0 -14 v34"/><path ${solid} d="M-3 20 L3 20 L0 28 Z"/></g>`;
const hammer = (x: number, y: number, r = -30) => `<g transform="translate(${x} ${y}) rotate(${r})"><path ${ink} d="M0 0 v90"/><path ${ink} d="M-26 -12 h44 v22 h-44 Z M18 -12 q14 4 14 22"/></g>`;
const screwdriver = (x: number, y: number, r = 0) => `<g transform="translate(${x} ${y}) rotate(${r})"><rect ${ink} x="-12" y="-80" width="24" height="46" rx="10"/><path ${ink} d="M0 -34 v40"/><path ${thin} d="M-5 6 h10"/></g>`;
const turn = (x: number, y: number, r: number) => `<path ${ink} d="M${x - r} ${y} A${r} ${r} 0 0 1 ${x + r} ${y}"/><path ${solid} d="M${x + r} ${y + 4} l-10 -14 l18 -2 Z"/>`;
const warn = (x: number, y: number) => `<path ${ink} d="M${x} ${y - 30} L${x + 32} ${y + 26} H${x - 32} Z"/><path ${ink} d="M${x} ${y - 10} v18"/><circle ${solid} cx="${x}" cy="${y + 16}" r="3.5"/>`;
const times = (x: number, y: number, n: number) => label(x, y, `${n}×`, 28);

const DIAGRAMS: Record<string, string> = {
  // Step 1: every part laid out with its letter.
  check_parts: [
    board(30, 60, 30, 240, 12), label(52, 336, 'G'), board(80, 60, 30, 240, 12), label(102, 336, 'G'),
    board(140, 70, 150, 26, 12), label(215, 124, 'H'), board(140, 150, 150, 26, 12), label(215, 204, 'H'),
    `<rect ${thin} x="140" y="230" width="150" height="80"/>`, label(215, 280, 'E'),
    bolt(340, 80, 0.9), label(340, 135, 'A', 24), dowel(395, 82, 0.9), label(395, 135, 'B', 24), camlock(447, 84, 16), label(447, 135, 'C', 24),
    `<path ${ink} d="M322 190 h40 v-26 h18 v62 h-58 Z"/>`, label(350, 252, 'D', 24), nail(420, 190, 0.9), label(420, 252, 'F', 24),
    `<path ${thin} d="M318 280 h140"/>`, label(388, 318, '✓', 30),
  ].join(''),
  // Step 2: cam bolts into the small holes on the inner face of a side panel.
  cam_bolts: [
    board(150, 30, 90, 300, 24),
    ...[80, 140, 220, 280].map((y) => `<circle ${solid} cx="225" cy="${y}" r="5"/>`),
    bolt(330, 90), arrow(318, 100, 240, 82), bolt(330, 230), arrow(318, 240, 240, 222),
    label(380, 100, 'A'), times(400, 160, 4), turn(415, 210, 18), label(52, 190, 'G'),
  ].join(''),
  // Step 3: two dowels into the end holes of each shelf, tap gently.
  dowels: [
    board(40, 190, 280, 40, 26),
    dowel(360, 196, 1, 90), dowel(360, 226, 1, 90), arrow(400, 160, 340, 160),
    hammer(410, 230, -60), label(180, 290, 'H'), label(370, 150, 'B'), times(440, 320, 4),
  ].join(''),
  // Step 4: left side panel onto both shelves, bolts into the large holes.
  left_side: [
    board(60, 30, 40, 300, 20),
    board(200, 90, 200, 26, 18), board(200, 230, 200, 26, 18),
    arrow(190, 103, 115, 103), arrow(190, 243, 115, 243),
    label(80, 352, 'G', 26), label(300, 150, 'H'), label(300, 292, 'H'),
  ].join(''),
  // Step 5: cam lock into the large hole, arrow to the bolt, half a turn clockwise.
  cam_locks: [
    `<rect ${ink} x="40" y="150" width="260" height="70"/>`, `<circle ${ink} cx="190" cy="185" r="26"/>`,
    `<path ${ink} d="M60 185 h100"/>`, label(70, 140, 'A', 24),
    camlock(190, 80, 30), arrow(190, 120, 190, 152), screwdriver(330, 230, 30), turn(190, 285, 40), label(240, 340, '½', 32), label(260, 90, 'C'),
  ].join(''),
  // Step 6: right side the same way: both sides on, then cam locks.
  right_side: [
    board(40, 40, 36, 280, 18), board(76, 100, 220, 24, 16), board(76, 230, 220, 24, 16),
    board(380, 40, 36, 280, 18), arrow(372, 112, 304, 112), arrow(372, 242, 304, 242),
    camlock(260, 175, 16), camlock(260, 300, 16), label(398, 352, 'G', 26), label(220, 175, 'C', 24),
  ].join(''),
  // Step 7: back panel slides down the grooves, smooth side forward.
  back_panel: [
    `<rect ${ink} x="90" y="70" width="300" height="270"/>`, `<path ${thin} d="M104 70 v270 M376 70 v270"/>`,
    `<rect ${ink} x="110" y="20" width="260" height="180" stroke-dasharray="14 10"/>`, arrow(240, 60, 240, 160),
    label(240, 270, 'E'), warn(430, 300),
  ].join(''),
  // Step 8: nail the back to the shelves. The manual's spacing figure is unreadable.
  nails: [
    `<rect ${ink} x="60" y="40" width="280" height="290"/>`, `<path ${thin} d="M60 150 h280 M60 250 h280"/>`,
    ...[90, 150, 210, 270, 310].map((x) => nail(x, 128, 0.8)), hammer(400, 120, -40),
    label(200, 205, '? ? ?', 30), label(400, 300, 'F'), times(400, 340, 16),
  ].join(''),
  // Step 9: fix to the wall with the bracket, or it can tip over.
  wall_fix: [
    `<path ${ink} d="M40 20 v320"/>`, `<path ${thin} d="M40 340 h420"/>`, ...[60, 120, 180, 240, 300].map((y) => `<path ${thin} d="M40 ${y} l-18 18"/>`),
    board(80, 60, 160, 280, 20), `<path ${ink} d="M60 70 h40 v-26 h18 v52 h-58 Z"/>`, label(90, 120, 'D', 24),
    arrow(150, 30, 52, 30), `<path ${thin} d="M44 56 h28 M44 62 h28"/>`, warn(380, 200),
  ].join(''),
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable' });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const out: Record<string, string> = {};
for (const [id, art] of Object.entries(DIAGRAMS)) {
  await page.setContent(`<body style="margin:0;background:#fff"><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${art}</svg></body>`);
  out[id] = (await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } })).toString('base64');
}
await browser.close();

const file = new URL('../../packages/applet-format/src/fixtures/bookcase-diagrams.ts', import.meta.url);
writeFileSync(file, `/**
 * Generated by scripts/coach/make-bookcase-diagrams.ts: original line diagrams
 * (PNG, base64) for each step of the two-shelf bookcase fixture. Do not edit.
 */
export const BOOKCASE_DIAGRAMS: Record<string, string> = ${JSON.stringify(out, null, 1)};
`);
console.log(Object.entries(out).map(([k, v]) => `${k} ${Math.round((v.length * 3) / 4 / 1024)} KB`).join('\n'));
