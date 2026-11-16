import { chromium, type Page } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bookcaseGuide } from '../../../packages/applet-format/src/fixtures/bookcase.ts';

const out = resolve('.data/demo-video/ui');
await mkdir(out, { recursive: true });
const url = 'http://127.0.0.1:5173/author/';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] });
const pause = (p: Page, ms = 2000) => p.waitForTimeout(ms);
const shot = (p: Page, name: string) => p.screenshot({ path: `${out}/${name}.png` });
const button = (p: Page, name: string | RegExp) => p.getByRole('button', {name, exact: typeof name === 'string'});
const account = `video${Date.now()}`;
let projectUrl = '';
async function seedNote(projectId: string) {
  const base = 'http://127.0.0.1:8080';
  const auth = `Bearer dev:${account}`;
  async function request(path: string, method = 'GET', body?: unknown, token = auth) {
    const r = await fetch(base + path, { method, headers: { authorization: token, ...(body ? {'content-type':'application/json'} : {}) }, ...(body ? {body:JSON.stringify(body)} : {}) });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return r.json() as Promise<any>;
  }
  const {code} = await request('/v1/devices/pairing-codes','POST');
  const {token} = await request('/v1/devices/pair','POST',{code,label:'Demo glasses'});
  const controller = new AbortController();
  const stream = await fetch(base + '/v1/notes/recorder/events',{headers:{authorization:auth},signal:controller.signal});
  const reader = stream.body!.getReader(); await reader.read();
  const id = randomUUID();
  try {
    await request('/v1/notes','POST',{id,projectId,viewId:'assembly',stepId:'left_side',pageLabel:'Step 4 · Left side'},`Bearer ${token}`);
    await request(`/v1/notes/${id}/recording`,'POST');
    // Valid, silent PCM WAV with a marker understood by the deterministic fake transcriber.
    const wav = Buffer.alloc(32044); wav.write('RIFF',0); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(16000,24); wav.writeUInt32LE(32000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length-44,40); wav.write('TRANSCRIPT:Remember to tighten the cam locks after fitting the left side.\0',44);
    const upload = await fetch(`${base}/v1/notes/${id}/audio?durationMs=1000&endReason=phone`,{method:'PUT',headers:{authorization:auth,'content-type':'audio/wav'},body:wav});
    if (!upload.ok) throw new Error(`Audio upload: ${upload.status} ${await upload.text()}`);
    for (let i=0;i<90;i++) { const {notes} = await request(`/v1/notes?projectId=${projectId}`); if (notes.find((n:any)=>n.id===id)?.status==='transcribed') return; await new Promise(r=>setTimeout(r,1000)); }
    throw new Error('Fake transcription timed out');
  } finally { controller.abort(); }
}
const jobs: [string, (p: Page) => Promise<void>][] = [
  ['p01-author', async p => {
    const created = await fetch('http://127.0.0.1:8080/v1/projects',{method:'POST',headers:{authorization:`Bearer dev:${account}`,'content-type':'application/json'},body:JSON.stringify({title:'Desk assembly'})});
    if (!created.ok) throw new Error(`Create project: ${created.status}`);
    await p.goto(url); await p.getByText('Desk assembly').waitFor(); await shot(p, 'p01-library'); await pause(p,2500);
    await p.getByText('Desk assembly').click(); await p.getByLabel('Message').waitFor(); projectUrl=p.url();
    const input = p.getByLabel('Message'); await input.click(); await pause(p,2500); await input.pressSequentially('Help me assemble this desk', {delay:110});
    await p.locator('input[type=file]').setInputFiles('experiments/openrouter-ikea-v2/upload/manual.pdf'); await p.getByText('manual.pdf').waitFor(); await shot(p,'p01-compose'); await pause(p,2500);
    await button(p,'Send').click(); await pause(p,700); await shot(p,'p01-generating');
    await p.getByRole('tab',{name:/Preview/}).click(); await p.getByText('Glasses view').waitFor({timeout:600000});
    await button(p,/Send version .*to glasses/).waitFor({state:'visible',timeout:600000}); await p.waitForFunction(() => { const b=[...document.querySelectorAll('button')].find(x=>/Send version .*to glasses/.test(x.textContent ?? '')); return b && !b.disabled; },null,{timeout:600000}); await p.waitForFunction(() => [...document.images].some(i => i.complete && i.naturalWidth > 0 && i.closest('[class*=preview], [class*=glasses], main')), null, {timeout:120000}).catch(() => {}); await pause(p,1500); await shot(p,'p01-preview'); for (let i=0;i<2;i++) { const next=p.getByRole('button',{name:'Next',exact:true}); if (await next.isVisible()) { await next.click(); await pause(p,2000); } } await pause(p,1000);
    const send = button(p,/Send version .*to glasses/); await send.scrollIntoViewIfNeeded(); await pause(p,1000); await send.click(); await p.getByText(/Sent!|On your glasses/).first().waitFor({timeout:90000}); await shot(p,'p01-sent'); await pause(p,2500);
  }],
  ['p02-laundry', async p => {
    await p.goto(url); await button(p,'Laundry from care labels').click(); await p.getByLabel('Garment name').waitFor(); await pause(p,2500);
    await p.getByLabel('Garment name').pressSequentially('Navy jeans',{delay:120}); await p.getByLabel('Care label photo').setInputFiles('packages/laundry/src/fixtures/labels/navy-jeans.png'); await shot(p,'p02-add'); await pause(p,2500);
    await button(p,'Add garment').click(); await button(p,'Confirm all as shown').waitFor({timeout:90000}); const card=p.locator('[data-garment]').first(); await card.scrollIntoViewIfNeeded(); await shot(p,'p02-review'); await pause(p,2500);
    await button(p,'Confirm all as shown').scrollIntoViewIfNeeded(); await pause(p,1000); await button(p,'Confirm all as shown').click(); await p.locator('.laundry-info select').first().selectOption('dark'); await pause(p,1200);
    await p.getByRole('heading',{name:'Sorting plan'}).scrollIntoViewIfNeeded(); await shot(p,'p02-plan'); await pause(p,2500); await button(p,'Send to glasses').click(); await p.getByText('Sent. Choose Sync on your glasses.').waitFor({timeout:90000}); await shot(p,'p02-sent'); await pause(p,2500);
  }],
  ['p03-notes', async p => {
    const headers = {authorization:`Bearer dev:${account}`,'content-type':'application/json'};
    const created = await fetch('http://127.0.0.1:8080/v1/projects',{method:'POST',headers,body:JSON.stringify({title:'Two-shelf bookcase'})});
    if (!created.ok) throw new Error(`Create note project: ${created.status}`);
    const {project} = await created.json() as any;
    const revision = await fetch(`http://127.0.0.1:8080/v1/projects/${project.id}/revisions`,{method:'POST',headers,body:JSON.stringify({definition:bookcaseGuide})});
    if (!revision.ok) throw new Error(`Create guide: ${revision.status} ${await revision.text()}`);
    await seedNote(project.id);
    await p.goto(`${url}#/p/${project.id}`); await p.getByRole('tab',{name:'Notes'}).click(); await pause(p,2500); await shot(p,'p03-notes');
    await p.getByRole('link',{name:'Note recorder'}).click(); await p.getByRole('heading',{name:'Note recorder'}).waitFor(); await shot(p,'p03-recorder'); await pause(p,2500);
  }],
];
let failed = false;
try {
  for (const [name, run] of jobs.filter(([n]) => !process.env.CLIPS || process.env.CLIPS.split(',').includes(n))) {
    console.log(`Recording ${name}`);
    const context = await browser.newContext({ viewport:{width:393,height:852}, deviceScaleFactor:3, recordVideo:{dir:out,size:{width:393,height:852}} });
    await context.addInitScript(({account}) => { localStorage.setItem('j26.session',JSON.stringify({server:'',token:`dev:${account}`,name:'Alex'})); localStorage.setItem('j26.welcomed','1'); }, {account});
    const page = await context.newPage(); const video = page.video()!;
    try { await run(page); } catch (e) { failed=true; console.error(`${name}:`,e); await shot(page,`${name}-error`).catch(()=>{}); }
    finally { await context.close(); const path=await video.path(); await rm(`${out}/${name}.webm`,{force:true}); await rename(path,`${out}/${name}.webm`); const ff=spawnSync('ffmpeg',['-y','-loglevel','error','-i',`${out}/${name}.webm`,'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',`${out}/${name}.mp4`]); if(ff.status!==0) {failed=true; console.error(`ffmpeg failed for ${name}`);} }
  }
} finally { await browser.close(); }
if(failed) process.exitCode=1;
