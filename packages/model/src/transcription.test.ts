import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptionRegistry, MistralTranscriptionProvider, ModelError } from './index.ts';

test('Mistral transcription sends a multipart file with language and context bias', async () => {
  let seen: { url: string; auth: string | null; form: FormData } | null = null;
  const p = new MistralTranscriptionProvider({
    apiKey: 'k',
    baseUrl: 'https://api.example/v1/',
    fetch: async (url, init) => {
      seen = { url: String(url), auth: new Headers(init?.headers).get('authorization'), form: init?.body as FormData };
      return new Response(JSON.stringify({ text: 'Row fourteen was tight.', usage: { prompt_audio_seconds: 120 } }));
    },
  });
  const r = await p.transcribe({ model: 'voxtral-mini-transcribe-3', audio: { data: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' }, language: 'en', vocabulary: ['magic ring', 'treble'] });
  assert.equal(r.text, 'Row fourteen was tight.');
  assert.equal(r.costUsd, 0.007);
  assert.equal(seen!.url, 'https://api.example/v1/audio/transcriptions');
  assert.equal(seen!.auth, 'Bearer k');
  assert.equal(seen!.form.get('model'), 'voxtral-mini-transcribe-3');
  assert.equal(seen!.form.get('language'), 'en');
  assert.deepEqual(seen!.form.getAll('context_bias'), ['magic ring', 'treble']);
  assert.equal((seen!.form.get('file') as File).type, 'audio/wav');
});

test('errors map to model error codes; missing key fails before any call', async () => {
  const p = new MistralTranscriptionProvider({ apiKey: 'k', baseUrl: 'https://x', fetch: async () => new Response('{"message":"bad key"}', { status: 401 }) });
  await assert.rejects(p.transcribe({ model: 'm', audio: { data: new Uint8Array(1), mediaType: 'audio/wav' } }), (e: ModelError) => e.code === 'auth');
  const none = new MistralTranscriptionProvider({ apiKey: undefined, baseUrl: 'https://x', fetch: async () => assert.fail('no call') });
  await assert.rejects(none.transcribe({ model: 'm', audio: { data: new Uint8Array(1), mediaType: 'audio/wav' } }), (e: ModelError) => e.code === 'not_configured');
});

test('registry resolves transcription specs only', () => {
  const r = createTranscriptionRegistry({ mistral: { apiKey: 'k', baseUrl: 'https://x' }, fake: () => 'hi' });
  assert.equal(r.resolve('mistral:voxtral-mini-transcribe-3')?.model, 'voxtral-mini-transcribe-3');
  assert.equal(r.resolve('fake:notes')?.provider.id, 'fake');
  assert.equal(r.resolve('google/gemini-3.1-flash-lite'), null);
  assert.equal(r.resolve('openrouter:google/gemini-3.1-flash-lite'), null);
});
