// Demo-video asset generator (OpenRouter). Spends real money only with --paid.
//   node scripts/demo-video/generate.ts estimate
//   node scripts/demo-video/generate.ts still  --paid            character reference image
//   node scripts/demo-video/generate.ts frames --paid [ids...]   first frames for ref shots
//   node scripts/demo-video/generate.ts video  --paid [ids...]   video clips
//   node scripts/demo-video/generate.ts voice  --paid [ids...]   voice-over lines (wav)
// Existing outputs are never regenerated: delete a file to redo it.
// Outputs: .data/demo-video/{stills,frames,clips,voice}
import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, '.data', 'demo-video');
const API = 'https://openrouter.ai/api/v1';

async function loadKey(): Promise<string> {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const env = await readFile(join(root, '.env.openrouter.local'), 'utf8');
  const m = env.match(/^OPENROUTER_API_KEY=(.+)$/m);
  if (!m) throw new Error('OPENROUTER_API_KEY not found');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

type Shot = { id: string; duration: number; ref: boolean; pov?: boolean; bare?: boolean; prompt: string };
const cfg = JSON.parse(await readFile(join(here, 'shots.json'), 'utf8')) as {
  videoModel: string; imageModel: string; resolution: string; aspectRatio: string;
  style: string; pov: string; character: string; characterStill: string; shots: Shot[];
};
const vo = JSON.parse(await readFile(join(here, 'voiceover.json'), 'utf8')) as {
  model: string; voices: Record<string, { voice: string; instructions: string }>;
  lines: { id: string; who: string; text: string }[];
};

const [cmd, ...rest] = process.argv.slice(2);
const paid = rest.includes('--paid');
const only = rest.filter((a) => !a.startsWith('--'));
const pick = <T extends { id: string }>(xs: T[]) => (only.length ? xs.filter((x) => only.includes(x.id)) : xs);
const exists = (p: string) => access(p).then(() => true, () => false);
const PRICE_PER_S: Record<string, number> = { '720p': 0.03, '1080p': 0.05 };

function shotPrompt(s: Shot): string {
  // bare: the shot starts without glasses, so the character text must not put them on the face.
  const who = s.pov ? cfg.pov : s.bare ? `${cfg.character.replace(/, wearing plain[^.]*\./, '.')} Their plain black rectangular glasses (no logos) start in their hand or on the box, not on their face.` : cfg.character;
  return `${s.prompt} ${who} ${cfg.style}`;
}

async function api(path: string, body: unknown, key: string): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 800)}`);
  return res;
}

async function writeAtomic(path: string, data: Buffer | string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.part`, data);
  await rename(`${path}.part`, path);
}

async function image(prompt: string, key: string, refs: string[] = []): Promise<Buffer> {
  const body: Record<string, unknown> = { model: cfg.imageModel, prompt, aspect_ratio: cfg.aspectRatio };
  if (refs.length) body.input_references = refs.map((url) => ({ type: 'image_url', image_url: { url } }));
  const json = (await (await api('/images', body, key)).json()) as { data: { b64_json: string }[]; usage?: { cost?: number } };
  console.log(`  image cost $${json.usage?.cost ?? '?'}`);
  return Buffer.from(json.data[0].b64_json, 'base64');
}
const dataUrl = async (p: string) => `data:image/png;base64,${(await readFile(p)).toString('base64')}`;

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()!).catch((e) => console.error(`  ✗ ${e.message}`)); }));
}

const stillPath = join(out, 'stills', 'character.png');

switch (cmd) {
  case 'estimate': {
    const secs = cfg.shots.reduce((a, s) => a + s.duration, 0);
    const refs = cfg.shots.filter((s) => s.ref).length;
    const chars = vo.lines.reduce((a, l) => a + l.text.length, 0);
    console.log(`${cfg.shots.length} shots, ${secs}s video @ ${cfg.resolution}: ~$${(secs * PRICE_PER_S[cfg.resolution]).toFixed(2)}`);
    console.log(`${refs + 1} images: ~$${((refs + 1) * 0.02).toFixed(2)}; voice ${chars} chars: < $0.05`);
    break;
  }
  case 'still': {
    if (!paid) throw new Error('Add --paid to spend money.');
    if (await exists(stillPath)) { console.log('character.png exists, skipping'); break; }
    const key = await loadKey();
    await writeAtomic(stillPath, await image(`${cfg.characterStill} ${cfg.character} ${cfg.style}`, key));
    console.log(`✓ ${stillPath}`);
    break;
  }
  case 'frames': {
    if (!paid) throw new Error('Add --paid to spend money.');
    const key = await loadKey();
    const ref = await dataUrl(stillPath);
    await pool(pick(cfg.shots).filter((s) => s.ref), 3, async (s) => {
      const p = join(out, 'frames', `${s.id}.png`);
      if (await exists(p)) return;
      const prompt = s.bare
        ? `First frame of a film shot, same person as the reference image (same face, hair, hoodie) but NOT wearing glasses: the black glasses are in their hand or on the cardboard box. ${s.prompt} ${cfg.style}`
        : `First frame of a film shot, same person as the reference image (same face, hair, hoodie, glasses). ${s.prompt} ${cfg.style}`;
      await writeAtomic(p, await image(prompt, key, [ref]));
      console.log(`✓ frame ${s.id}`);
    });
    break;
  }
  case 'video': {
    if (!paid) throw new Error('Add --paid to spend money.');
    const key = await loadKey();
    await pool(pick(cfg.shots), 4, async (s) => {
      const p = join(out, 'clips', `${s.id}.mp4`);
      if (await exists(p)) { console.log(`  skip ${s.id} (exists)`); return; }
      const frame = join(out, 'frames', `${s.id}.png`);
      const body: Record<string, unknown> = {
        model: cfg.videoModel, prompt: shotPrompt(s), duration: s.duration,
        resolution: cfg.resolution, aspect_ratio: cfg.aspectRatio, generate_audio: false,
      };
      if (s.ref && (await exists(frame))) body.frame_images = [{ type: 'image_url', image_url: { url: await dataUrl(frame) }, frame_type: 'first_frame' }];
      const job = (await (await api('/videos', body, key)).json()) as { id: string; polling_url: string };
      console.log(`  submitted ${s.id} (${job.id})${body.frame_images ? ' with first frame' : ''}`);
      for (;;) {
        await new Promise((r) => setTimeout(r, 20_000));
        const st = (await (await fetch(job.polling_url, { headers: { Authorization: `Bearer ${key}` } })).json()) as {
          status: string; unsigned_urls?: string[]; usage?: { cost?: number }; error?: unknown;
        };
        if (st.status === 'pending' || st.status === 'in_progress') continue;
        if (st.status !== 'completed' || !st.unsigned_urls?.[0]) throw new Error(`${s.id} ${st.status} ${JSON.stringify(st.error)}`);
        const vid = await fetch(st.unsigned_urls[0], { headers: { Authorization: `Bearer ${key}` } });
        await writeAtomic(p, Buffer.from(await vid.arrayBuffer()));
        console.log(`✓ ${s.id} $${st.usage?.cost ?? '?'}`);
        return;
      }
    });
    break;
  }
  case 'voice': {
    if (!paid) throw new Error('Add --paid to spend money.');
    const key = await loadKey();
    await pool(pick(vo.lines), 4, async (l) => {
      const p = join(out, 'voice', `${l.id}-${l.who}.wav`);
      if (await exists(p)) return;
      const v = vo.voices[l.who];
      const res = await api('/audio/speech', { model: vo.model, input: l.text, voice: v.voice, instructions: v.instructions, response_format: 'pcm' }, key);
      const pcm = join(out, 'voice', `${l.id}-${l.who}.pcm`);
      await writeAtomic(pcm, Buffer.from(await res.arrayBuffer()));
      // Gemini TTS returns 24 kHz signed 16-bit mono PCM.
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, `${p}.tmp.wav`]);
      await rename(`${p}.tmp.wav`, p);
      console.log(`✓ voice ${l.id}`);
    });
    break;
  }
  default:
    console.log('Usage: generate.ts estimate | still | frames | video | voice  [--paid] [ids...]');
}
