/**
 * Stand-in for the phone note recorder (docs/voice-notes.md). Waits for the
 * glasses to start a note, "records" for a few seconds (or until the glasses
 * send stop), then uploads a WAV: your file, or a generated clip whose bytes
 * carry a transcript the free `fake:notes` model reads back.
 *
 *   node scripts/voice/recorder.ts                       # fake clip, "Medium heat worked better."
 *   node scripts/voice/recorder.ts --text "Row 14 was tight" --seconds 3
 *   node scripts/voice/recorder.ts --wav note.wav        # real audio (for a real NOTES_TRANSCRIBE_MODEL)
 *   VOICE_API=https://… VOICE_TOKEN=<clerk session jwt> node scripts/voice/recorder.ts
 *
 * Defaults: http://127.0.0.1:8080 and the dev user `dev:me` (AUTH_MODE=dev).
 * Runs until Ctrl-C; handles one note at a time.
 */
import { readFileSync } from 'node:fs';

const api = (process.env.VOICE_API ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const token = process.env.VOICE_TOKEN ?? 'dev:me';
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const file = opt('wav');
const text = opt('text') ?? 'Medium heat worked better.';
const seconds = Number(opt('seconds') ?? '4');
const auth = { authorization: `Bearer ${token}` };

function fakeClip(ms: number): Buffer {
  const data = Buffer.alloc(Math.round(16 * ms) * 2);
  // Speech-level noise so the phone-side "too short" rule would keep it.
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(Math.round((Math.random() * 2 - 1) * 9000), i);
  data.write(`TRANSCRIPT:${text}\0`, 200, 'latin1');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let current: { id: string; stop: () => void } | null = null;

async function record(note: { id: string; pageLabel: string }) {
  if (current) return console.log('ignoring a second start while recording');
  console.log(`● start "${note.pageLabel}" (${note.id})`);
  const started = Date.now();
  let reason = 'phrase';
  await fetch(`${api}/v1/notes/${note.id}/recording`, { method: 'POST', headers: auth });
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, seconds * 1000);
    current = { id: note.id, stop: () => { clearTimeout(t); reason = 'band'; resolve(); } };
  });
  current = null;
  const ms = Date.now() - started;
  const body = file ? readFileSync(file) : fakeClip(ms);
  const res = await fetch(`${api}/v1/notes/${note.id}/audio?durationMs=${ms}&endReason=${reason}`, { method: 'PUT', headers: { ...auth, 'content-type': 'audio/wav' }, body });
  console.log(`■ uploaded ${body.length} bytes (${reason}) →`, res.status, (await res.json()).note?.status);
}

for (;;) {
  try {
    const res = await fetch(`${api}/v1/notes/recorder/events`, { headers: auth });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    console.log('recorder on; waiting for the glasses…');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!data) continue;
        const e = JSON.parse(data);
        if (event === 'start') void record(e.note);
        if (event === 'stop' && current?.id === e.noteId) current.stop();
      }
    }
  } catch (err) {
    console.error('recorder stream:', (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
