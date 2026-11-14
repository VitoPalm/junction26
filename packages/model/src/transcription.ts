import { ModelError } from './types.ts';

/**
 * Dedicated speech-to-text models (an audio file in, text out), separate from
 * chat models: the most accurate transcription models are served this way.
 * Specs are "provider:model", e.g. "mistral:voxtral-mini-transcribe-3".
 * Used for voice-note transcripts (docs/voice-notes.md).
 */
export interface TranscriptionRequest {
  model: string;
  audio: { data: Uint8Array; mediaType: 'audio/wav' | 'audio/mpeg' };
  /** ISO 639-1, e.g. "en". */
  language?: string;
  /** Words and phrases the speaker is likely to say (spelling hints). */
  vocabulary?: string[];
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  provider: string;
  model: string;
  /** Seconds of audio the provider billed, when reported. */
  audioSeconds: number | null;
  costUsd: number | null;
}

export interface TranscriptionProvider {
  readonly id: string;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** Published per-minute prices (USD), for cost logging only. Mistral, checked 2026-11-14. */
const PER_MINUTE: Record<string, number> = {
  'voxtral-mini-transcribe-3': 0.0035,
  'voxtral-small-transcribe-3': 0.004,
};
/** Context-bias entries are part of the model's context; keep the list short. */
const MAX_VOCABULARY = 100;

/** Mistral's /v1/audio/transcriptions (Voxtral transcribe models). */
export class MistralTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'mistral';
  private readonly o: { apiKey: string | undefined; baseUrl: string; timeoutMs?: number; fetch?: typeof fetch };
  constructor(o: { apiKey: string | undefined; baseUrl: string; timeoutMs?: number; fetch?: typeof fetch }) {
    this.o = o;
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!this.o.apiKey) throw new ModelError('not_configured', 'No API key for transcription provider "mistral" (MISTRAL_API_KEY)');
    const form = new FormData();
    form.append('model', req.model);
    form.append('file', new Blob([req.audio.data as Uint8Array<ArrayBuffer>], { type: req.audio.mediaType }), req.audio.mediaType === 'audio/mpeg' ? 'note.mp3' : 'note.wav');
    if (req.language) form.append('language', req.language);
    for (const w of (req.vocabulary ?? []).slice(0, MAX_VOCABULARY)) form.append('context_bias', w);
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 180_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}` },
        body: form,
        signal,
      });
    } catch (e) {
      if (timeout.aborted) throw new ModelError('timeout', 'The transcription took too long');
      if (req.signal?.aborted) throw e;
      throw new ModelError('unavailable', `Transcription request failed: ${(e as Error).message}`);
    }
    const raw = await res.text();
    let json: { text?: unknown; usage?: { prompt_audio_seconds?: unknown }; message?: unknown; detail?: unknown } = {};
    try {
      json = JSON.parse(raw);
    } catch {
      /* handled below */
    }
    if (!res.ok) throw statusError(res.status, String(json.message ?? json.detail ?? raw.slice(0, 200)));
    if (typeof json.text !== 'string') throw new ModelError('invalid_response', 'The transcription response had no text');
    const seconds = typeof json.usage?.prompt_audio_seconds === 'number' ? json.usage.prompt_audio_seconds : null;
    const rate = PER_MINUTE[req.model];
    return { text: json.text, provider: 'mistral', model: req.model, audioSeconds: seconds, costUsd: seconds !== null && rate ? (seconds / 60) * rate : null };
  }
}

/** OpenRouter's dedicated STT endpoint; uses the existing backend OpenRouter key. */
export class OpenRouterTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'openrouter-stt';
  private readonly o: { apiKey: string | undefined; baseUrl: string; timeoutMs?: number; fetch?: typeof fetch };
  constructor(o: { apiKey: string | undefined; baseUrl: string; timeoutMs?: number; fetch?: typeof fetch }) { this.o = o; }
  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!this.o.apiKey) throw new ModelError('not_configured', 'OPENROUTER_API_KEY is required for transcription');
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 180_000);
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          input_audio: { data: Buffer.from(req.audio.data).toString('base64'), format: req.audio.mediaType === 'audio/mpeg' ? 'mp3' : 'wav' },
          language: req.language,
          provider: { options: Object.fromEntries(['mistral', 'mistral/zdr', 'mistral/us', 'mistral/eu'].map(tag => [tag, { context_bias: (req.vocabulary ?? []).slice(0, MAX_VOCABULARY) }])) },
        }),
        signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
      });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      throw new ModelError(timeout.aborted ? 'timeout' : 'unavailable', 'OpenRouter transcription request failed');
    }
    const json = await res.json().catch(() => null) as { text?: unknown; usage?: { cost?: number; seconds?: number }; error?: { message?: string } } | null;
    if (!res.ok) throw statusError(res.status, json?.error?.message ?? 'OpenRouter transcription failed');
    if (typeof json?.text !== 'string') throw new ModelError('invalid_response', 'The transcription response had no text');
    return { text: json.text, provider: this.id, model: req.model, audioSeconds: json.usage?.seconds ?? null, costUsd: json.usage?.cost ?? null };
  }
}

function statusError(s: number, m: string): ModelError {
  if (s === 401 || s === 403) return new ModelError('auth', `The transcription provider refused the key: ${m}`, s);
  if (s === 402) return new ModelError('insufficient_credits', 'The transcription budget is used up', s);
  if (s === 429) return new ModelError('rate_limited', 'The transcription provider is rate limiting us', s);
  if (s === 400 && /context|too long/i.test(m)) return new ModelError('context_too_long', 'The recording is too long for this model', s);
  if (s >= 400 && s < 500) return new ModelError('bad_request', m, s);
  return new ModelError('unavailable', m, s);
}

/** Free, deterministic stand-in ("fake:<anything>") for development and tests. */
export class FakeTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'fake';
  readonly calls: TranscriptionRequest[] = [];
  private readonly respond: (req: TranscriptionRequest) => string;
  constructor(respond: (req: TranscriptionRequest) => string) {
    this.respond = respond;
  }
  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    req.signal?.throwIfAborted();
    this.calls.push(req);
    return { text: this.respond(req), provider: 'fake', model: req.model, audioSeconds: null, costUsd: 0 };
  }
}

/** "provider:model" → provider. Unknown providers are a configuration error, not a silent fallback. */
export class TranscriptionRegistry {
  private readonly providers = new Map<string, TranscriptionProvider>();
  register(p: TranscriptionProvider): this {
    this.providers.set(p.id, p);
    return this;
  }
  /** Null when the spec isn't a transcription provider (e.g. a chat model with audio input). */
  resolve(spec: string): { provider: TranscriptionProvider; model: string; id: string } | null {
    const i = spec.indexOf(':');
    if (i <= 0) return null;
    const provider = this.providers.get(spec.slice(0, i));
    return provider ? { provider, model: spec.slice(i + 1), id: spec } : null;
  }
}

export function createTranscriptionRegistry(config: {
  openRouter?: { apiKey: string | undefined; baseUrl: string };
  mistral?: { apiKey: string | undefined; baseUrl: string };
  fake?: (req: TranscriptionRequest) => string;
}): TranscriptionRegistry {
  const r = new TranscriptionRegistry();
  if (config.openRouter) r.register(new OpenRouterTranscriptionProvider(config.openRouter));
  if (config.mistral) r.register(new MistralTranscriptionProvider(config.mistral));
  if (config.fake) r.register(new FakeTranscriptionProvider(config.fake));
  return r;
}
