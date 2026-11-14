/**
 * Pure audio helpers for the voice-note recorder (docs/voice-notes.md). No
 * browser APIs here, so they run in node tests.
 */

export const RATE = 16_000;
/** 20 ms analysis frames. */
export const FRAME = RATE / 50;

/** Averaging downsampler (input rate → 16 kHz mono). Good enough for speech. */
export function downsample(input: Float32Array, fromRate: number, toRate = RATE): Float32Array {
  if (fromRate === toRate) return input.slice();
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** 16-bit PCM WAV, mono. */
export function encodeWav(samples: Float32Array, rate = RATE): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** RMS per 20 ms frame. */
export function frameRms(samples: Float32Array): Float32Array {
  const n = Math.floor(samples.length / FRAME);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += samples[i]! * samples[i]!;
    out[f] = Math.sqrt(sum / FRAME);
  }
  return out;
}

/**
 * "stop recording meta", tolerantly: recognisers write Meta as metta, better,
 * matter, medal… We only accept it at the end of what was heard, so the words
 * inside a note ("I should stop recording rows twice") don't end it.
 */
const STOP = /\bstop(?:ped|ping)?\s+(?:the\s+)?recording\b[\s,.]*(?:meta|metta|metal|medal|matter|better|media|mehta|met a|mesa|mena)\b[\s.!?]*$/i;
export function endsWithStopPhrase(text: string): boolean {
  return STOP.test(text.trim());
}

/**
 * Where to cut the stop phrase off the end. Speech recognisers report the
 * phrase late (after it ends), without word timings, so we look back from
 * the detection for the pause before the phrase: the last run of ≥200 ms
 * quiet frames within `lookbackMs`. Without a pause, cut a typical phrase
 * length (1.6 s) back. Returns a sample index.
 */
export function findStopCut(samples: Float32Array, detectedAt: number, opts: { lookbackMs?: number; phraseMs?: number } = {}): number {
  const lookback = opts.lookbackMs ?? 3500;
  const phrase = opts.phraseMs ?? 1600;
  const rms = frameRms(samples.subarray(0, Math.min(samples.length, detectedAt)));
  if (!rms.length) return 0;
  const sorted = [...rms].sort((a, b) => a - b);
  // Noise floor from the quietest 5% of the note (people pause rarely when
  // dictating); speech is well above it. Never call more than a third of the
  // speech level "quiet".
  const floor = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const peak = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const quiet = Math.min(Math.max(floor * 2.5, floor + (peak - floor) * 0.12, 0.004), peak * 0.35);
  const detFrame = rms.length - 1;
  const minFrame = Math.max(0, detFrame - Math.round(lookback / 20));
  // Skip trailing silence after the phrase, then walk back through the phrase.
  let f = detFrame;
  while (f > minFrame && rms[f]! < quiet) f--;
  let run = 0;
  for (; f > minFrame; f--) {
    if (rms[f]! < quiet) {
      run++;
      if (run >= 10) return (f + run - Math.ceil(run / 2)) * FRAME;
    } else if (run) {
      run = 0;
    }
  }
  if (run >= 10) return (f + run - Math.ceil(run / 2)) * FRAME;
  return Math.max(0, Math.min(samples.length, detectedAt - Math.round((phrase * RATE) / 1000)));
}

/** True if there is at least `minMs` of speech-level audio (not just hiss). */
export function hasSpeech(samples: Float32Array, minMs = 600): boolean {
  const rms = frameRms(samples);
  if (!rms.length) return false;
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const loud = rms.filter((r) => r > Math.max(floor * 3, 0.01)).length;
  return loud * 20 >= minMs;
}

/** Streaming version of `downsample`: keeps the fractional tail between chunks. */
export class Downsampler {
  private carry = new Float32Array(0);
  private readonly from: number;
  private readonly to: number;
  constructor(from: number, to = RATE) {
    this.from = from;
    this.to = to;
  }
  push(chunk: Float32Array): Float32Array {
    if (this.from === this.to) return chunk.slice();
    const buf = new Float32Array(this.carry.length + chunk.length);
    buf.set(this.carry);
    buf.set(chunk, this.carry.length);
    const ratio = this.from / this.to;
    const n = Math.floor(buf.length / ratio);
    const out = downsample(buf.subarray(0, Math.floor(n * ratio)), this.from, this.to);
    this.carry = buf.slice(Math.floor(n * ratio));
    return out;
  }
}

export function concat(chunks: Float32Array[], total?: number): Float32Array {
  const out = new Float32Array(total ?? chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c.subarray(0, Math.min(c.length, out.length - o)), o);
    o += c.length;
    if (o >= out.length) break;
  }
  return out;
}
