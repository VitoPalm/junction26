import { chromium, type Page } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const out = resolve('.data/demo-video/ui');
await mkdir(out, { recursive: true });
const server = spawn('npm', ['run', 'dev', '-w', '@junction26/glasses', '--', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
const url = 'http://127.0.0.1:5174/glasses/?webmcp';
for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] });
const pause = (p: Page, ms = 1000) => p.waitForTimeout(ms);
const button = (p: Page, name: string | RegExp) => p.getByRole('button', { name, exact: typeof name === 'string' });
async function activate(p: Page, name: string | RegExp) {
  const target = button(p, name); await target.waitFor({ state: 'visible' });
  for (let i = 0; i < 24; i++) {
    if (await target.evaluate(el => el === document.activeElement)) { await p.keyboard.press('Enter'); await p.waitForTimeout(350); return; }
    const [a, b] = await Promise.all([p.locator(':focus').boundingBox(), target.boundingBox()]);
    if (!a || !b) { await p.keyboard.press('ArrowDown'); continue; }
    const dx = b.x + b.width/2 - a.x - a.width/2, dy = b.y + b.height/2 - a.y - a.height/2;
    await p.keyboard.press(Math.abs(dy) > 50 ? (dy < 0 ? 'ArrowUp' : 'ArrowDown') : (dx < 0 ? 'ArrowLeft' : 'ArrowRight'));
  }
  throw new Error(`Cannot reach ${name} by keyboard; active=${await p.evaluate(() => document.activeElement?.textContent)}`);
}
async function call(p: Page, name: string, args: Record<string, unknown> = {}) { return p.evaluate(([n,a]) => (window as any).webmcp.call(n,a), [name,args] as const); }
async function open(p: Page, name: string) {
  await p.goto(url); const tile = button(p, new RegExp(name));
  if (!await tile.isVisible()) { await activate(p, 'Older'); await p.getByRole('heading', {name:'Older solutions'}).waitFor(); for (let i = 0; i < 5 && !await tile.isVisible(); i++) await activate(p, 'Next page'); }
  await activate(p, new RegExp(name)); await pause(p, 500);
}
async function shot(p: Page, name: string) { await p.screenshot({ path: `${out}/${name}.png` }); }
async function paired(p: Page) {
  await open(p, 'Two-shelf bookcase');
  await p.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open('junction26-glasses', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const demo: any = await new Promise(res => { const r = db.transaction('applets').objectStore('applets').get('demo-bookcaseGuide'); r.onsuccess = () => res(r.result); });
    await new Promise<void>((res, rej) => { const t = db.transaction(['applets','meta','state'], 'readwrite');
      // Remove all examples to avoid the known paired-home dock overflow.
      t.objectStore('applets').clear(); t.objectStore('state').clear();
      t.objectStore('applets').put({ ...demo, projectId: '11111111-1111-4111-8111-111111111111', demo: false, releaseId: 'rel1', revisionId: 'rev1' });
      t.objectStore('meta').put({ token: 'j26d_test-token', deviceId: 'dev1', pairedAt: new Date().toISOString() }, 'pairing'); t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    }); db.close();
  });
  await p.goto(url); await activate(p, /Two-shelf bookcase/);
}
const proposal = { kind: 'problem', recovery: { status: 'proposal', title: 'Redo: Left side', rationale: 'Undo the part that went on the wrong way, then fit it again.', returnStepId: 'left_side', sources: [{ page: 3, section: 'Step 4' }], steps: [ { text: 'Undo that step: loosen any cam locks and take the part off.', source: { page: 3, section: 'Step 4' } }, { text: 'Turn the part around so it matches the manual.', source: { page: 3, section: 'Step 4' } }, { text: 'Fit it again as in step 4.', source: { page: 3, section: 'Step 4' } } ] } };
const jobs: [string, (p: Page) => Promise<void>][] = [
 ['01-home', async p => { await p.goto(url); await pause(p, 1500); await shot(p, '01-home'); await activate(p, /Two-shelf bookcase/); await pause(p, 2000); await shot(p, '01-selected'); }],
 ['02-steps', async p => { await open(p, 'Two-shelf bookcase'); for (let i=1;i<=3;i++) { await shot(p, `02-step-${i}`); await pause(p, 2500); if(i<3) await activate(p, 'Next'); } }],
 ['03-ask', async p => { await open(p, 'Two-shelf bookcase'); await activate(p, 'Next'); await activate(p, 'More'); await activate(p, 'Ask a question'); await shot(p, '03-question'); await pause(p, 3000); await activate(p, 'Which parts do I need?'); await p.getByText(/4 × Cam bolt/).waitFor(); await shot(p, '03-answer'); await pause(p, 4000); }],
 ['04-problem', async p => { await p.route('**/v1/coach/requests', r => r.fulfill({ status: 202, json: { request: { id: 'job1', status: 'queued', result: null, error: null } } })); await p.route('**/v1/coach/requests/job1', r => r.fulfill({ json: { request: { id: 'job1', status: 'succeeded', result: proposal, error: null } } })); await paired(p); for(let i=0;i<3;i++) await activate(p, 'Next'); await activate(p, 'More'); await activate(p, 'Next page'); await activate(p, 'Report a problem'); await shot(p, '04-problem-options'); await pause(p, 3000); const names = await p.getByRole('button').allTextContents(); console.log('problem options:', names); const preset = names.find(x => /backward/i.test(x)); if (!preset) throw new Error('No backwards preset'); await activate(p, preset.trim()); await p.getByText('Proposed fix · 3 steps').waitFor({ timeout: 15000 }); await shot(p, '04-proposal'); await pause(p, 4000); await activate(p, 'Use this fix'); await p.getByText('Fix 1 of 3').waitFor(); await shot(p, '04-fix-1'); await pause(p, 2500); await activate(p, 'Next'); await pause(p, 1500); await activate(p, 'Next'); await pause(p, 1500); await activate(p, 'Back to guide'); await p.getByText(/Step 4 of 9/i).waitFor(); await shot(p, '04-return'); await pause(p, 2000); }],
 ['05-resume', async p => { await open(p, 'Two-shelf bookcase'); await activate(p, 'Next'); await activate(p, 'Next'); await shot(p, '05-before'); await pause(p, 2000); await p.reload(); await p.getByText(/Step 3 of 9/i).waitFor(); await shot(p, '05-resumed'); await pause(p, 3000); }],
 ['06-laundry', async p => { await open(p, 'Laundry: Sunday load'); for(let i=0;i<30;i++) { const heading = await p.getByRole('heading').first().textContent(); if (/ · Sort$/.test(heading ?? '')) break; await call(p, 'j26_laundry_confirm_step'); await pause(p, 400); } await shot(p, '06-sort'); await pause(p, 2500); await activate(p, 'Confirm sorted'); await pause(p, 600); for(let i=0;i<30;i++) { const heading = await p.getByRole('heading').first().textContent(); if (/ · Wash$/.test(heading ?? '')) break; await call(p, 'j26_laundry_confirm_step'); await pause(p, 400); } await shot(p, '06-wash'); await pause(p, 2500); await activate(p, 'Wash done'); await shot(p, '06-confirmed'); await pause(p, 2000); }],
 ['09-cooking', async p => { await open(p, 'Pancakes'); await shot(p, '09-cooking-1'); for (let i=0;i<3;i++) { await pause(p,2500); await activate(p,'Next'); } await shot(p, '09-cooking-2'); await pause(p,2000); }],
 ['07-counter', async p => { await open(p, 'Row counter'); await shot(p, '07-counter'); const names = await p.getByRole('button').allTextContents(); console.log('counter buttons:', names); const inc = names.find(x => /\+1|increment|add row/i.test(x)); if(!inc) throw new Error('Counter increment not found'); for(let i=0;i<4;i++) { await pause(p,1000); await activate(p,inc.trim()); } await shot(p, '07-incremented'); await pause(p,1000); }],
 ['08-dnd', async p => { await open(p, 'Brakka the Bold'); await shot(p, '08-before'); await pause(p,3000); await call(p,'j26_dnd_take_damage',{amount:5}); await p.getByText('19 / 24',{exact:true}).waitFor(); await shot(p, '08-after'); await pause(p,3000); }],
];
let failed = false;
try { for (const [name, run] of jobs.filter(([name]) => !process.env.CLIPS || process.env.CLIPS.split(',').includes(name))) { console.log(`Recording ${name}`); const context = await browser.newContext({ viewport: {width:600,height:600}, recordVideo: {dir:out,size:{width:600,height:600}} }); const page = await context.newPage(); await page.addInitScript(() => { const style = document.createElement('style'); style.textContent = 'html,body,#root { background: #000 !important; }'; document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style)); }); const video = page.video()!; try { await run(page); } catch(e) { failed=true; console.error(`${name}:`, e); await shot(page, `${name}-error`).catch(()=>{}); } finally { await context.close(); const path = await video.path(); await rm(`${out}/${name}.webm`, {force:true}); await rename(path, `${out}/${name}.webm`); const ff = spawnSync('ffmpeg',['-y','-loglevel','error','-i',`${out}/${name}.webm`,'-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',`${out}/${name}.mp4`]); if(ff.status !== 0) console.error(`ffmpeg failed for ${name}`); } } } finally { await browser.close(); server.kill('SIGTERM'); }
if(failed) process.exitCode=1;
