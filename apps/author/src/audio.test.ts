import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATE, downsample, encodeWav, endsWithStopPhrase, findStopCut, hasSpeech } from './audio.ts';

/** Speech-like noise bursts at `amp` for each [startMs, endMs). */
function signal(totalMs: number, bursts: [number, number][], amp = 0.3): Float32Array {
  const s = new Float32Array((totalMs * RATE) / 1000);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < s.length; i++) s[i] = rnd() * 0.002;
  for (const [a, b] of bursts) for (let i = (a * RATE) / 1000; i < (b * RATE) / 1000; i++) s[i] = rnd() * amp;
  return s;
}

test('stop phrase only at the end, tolerant of misheard "meta"', () => {
  assert.equal(endsWithStopPhrase('turn the heat down stop recording meta'), true);
  assert.equal(endsWithStopPhrase('Turn the heat down. Stop recording, Metta.'), true);
  assert.equal(endsWithStopPhrase('stop recording better'), true);
  assert.equal(endsWithStopPhrase('stop recording meta and then add flour'), false);
  assert.equal(endsWithStopPhrase('I will stop recording rows'), false);
});

test('cut lands in the pause before the stop phrase', () => {
  // Note speech 0–3 s, pause 3–3.5 s, "stop recording meta" 3.5–5 s, detected at 5.6 s.
  const s = signal(6000, [[0, 3000], [3500, 5000]]);
  const cut = findStopCut(s, (5600 * RATE) / 1000);
  const ms = (cut / RATE) * 1000;
  assert.ok(ms > 3000 && ms < 3500, `cut at ${ms} ms`);
});

test('without a pause, cut a phrase length back from detection', () => {
  const s = signal(6000, [[0, 6000]]);
  const cut = findStopCut(s, (6000 * RATE) / 1000);
  assert.equal(cut, ((6000 - 1600) * RATE) / 1000);
});

test('speech detection and WAV encoding', () => {
  assert.equal(hasSpeech(signal(3000, [])), false);
  assert.equal(hasSpeech(signal(3000, [[500, 2000]])), true);
  const wav = encodeWav(new Float32Array(RATE));
  assert.equal(wav.length, 44 + RATE * 2);
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');
  assert.equal(downsample(new Float32Array(48_000), 48_000).length, RATE);
});
