/**
 * Stand-in for the phone voice bridge (docs/voice-fallback.md): posts one
 * utterance as text, or a WAV file, to the API as a signed-in user.
 *
 *   node scripts/voice/say.ts "add two rows"
 *   node scripts/voice/say.ts --wav clip.wav
 *   VOICE_API=https://… VOICE_TOKEN=<clerk session jwt> node scripts/voice/say.ts "next step"
 *
 * Defaults: http://127.0.0.1:8080 and the local dev user `dev:me` (AUTH_MODE=dev).
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const api = (process.env.VOICE_API ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const token = process.env.VOICE_TOKEN ?? 'dev:me';
const args = process.argv.slice(2);
const wav = args[0] === '--wav' ? args[1] : undefined;
const text = wav ? undefined : args.join(' ').trim();
if (!wav && !text) {
  console.error('Usage: say.ts "<what you would say>" | --wav <file.wav>');
  process.exit(2);
}

const started = performance.now();
const res = await fetch(`${api}/v1/voice/utterances`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'x-utterance-id': randomUUID(),
    'content-type': wav ? 'audio/wav' : 'application/json',
  },
  body: wav ? readFileSync(wav) : JSON.stringify({ text }),
});
const body = await res.json();
console.log(res.status, `${Math.round(performance.now() - started)} ms`, JSON.stringify(body));
process.exit(res.ok ? 0 : 1);
