import type { CompletionRequest, FakeReply, ModelRegistry } from '@junction26/model';
import { ModelError } from '@junction26/model';

/**
 * Voice notes core (docs/voice-notes.md). The glasses start a note (Meta AI
 * calls the WebMCP tool, or a band pinch); the phone recorder records it and
 * uploads the audio. This hub carries the start/stop signals between them.
 *
 * Privacy: audio is stored (the feature keeps it, by owner decision) but is
 * never logged. Live stop-phrase windows are checked and thrown away.
 */

export const STOP_PHRASE = 'stop recording meta';

/** To the phone recorder. */
export type RecorderEvent =
  | {
      type: 'start';
      note: { id: string; projectId: string; viewId: string; stepId: string | null; pageLabel: string; noteLabel: string | null; maxSeconds: number };
    }
  | { type: 'stop'; noteId: string; reason: 'band' | 'voice' | 'timeout' };

/** To the glasses showing a note. */
export type NoteEvent =
  | { type: 'status'; noteId: string; status: string }
  | { type: 'recording'; noteId: string; startedAt: string }
  | { type: 'stopping'; noteId: string; reason: string }
  | { type: 'saved'; noteId: string }
  | { type: 'discarded'; noteId: string; reason: string | null };

interface Recorder {
  send: (e: RecorderEvent) => void;
  since: number;
}

/**
 * In-process fan-out, keyed by owner so one user can never signal another
 * user's phone or glasses. Same scaling note as VoiceHub: more than one API
 * instance needs Postgres LISTEN/NOTIFY.
 */
export class NoteHub {
  private readonly recorders = new Map<string, Set<Recorder>>();
  private readonly listeners = new Map<string, Set<(e: NoteEvent) => void>>();
  /** userId → note being recorded now (pauses the voice-command bridge). */
  private readonly recording = new Map<string, { noteId: string; until: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  subscribeRecorder(userId: string, send: (e: RecorderEvent) => void): () => void {
    let set = this.recorders.get(userId);
    if (!set) this.recorders.set(userId, (set = new Set()));
    const r = { send, since: this.now() };
    set.add(r);
    return () => {
      set.delete(r);
      if (!set.size) this.recorders.delete(userId);
    };
  }

  hasRecorder(userId: string): boolean {
    return (this.recorders.get(userId)?.size ?? 0) > 0;
  }

  /** Starts go to the most recently connected recorder only, so two open phones don't both record. */
  startOnRecorder(userId: string, e: Extract<RecorderEvent, { type: 'start' }>): boolean {
    const set = this.recorders.get(userId);
    if (!set?.size) return false;
    const newest = [...set].reduce((a, b) => (b.since >= a.since ? b : a));
    newest.send(e);
    return true;
  }

  /** Stops go to every recorder of the user; ones not recording that note ignore it. */
  stopOnRecorders(userId: string, e: Extract<RecorderEvent, { type: 'stop' }>): number {
    const set = this.recorders.get(userId);
    for (const r of set ?? []) r.send(e);
    return set?.size ?? 0;
  }

  subscribeNote(userId: string, noteId: string, send: (e: NoteEvent) => void): () => void {
    const k = `${userId}:${noteId}`;
    let set = this.listeners.get(k);
    if (!set) this.listeners.set(k, (set = new Set()));
    set.add(send);
    return () => {
      set.delete(send);
      if (!set.size) this.listeners.delete(k);
    };
  }

  toNote(userId: string, e: NoteEvent): number {
    const set = this.listeners.get(`${userId}:${e.noteId}`);
    for (const send of set ?? []) send(e);
    return set?.size ?? 0;
  }

  setRecording(userId: string, noteId: string | null, maxMs = 0) {
    if (noteId) this.recording.set(userId, { noteId, until: this.now() + maxMs + 60_000 });
    else this.recording.delete(userId);
  }

  clearRecording(userId: string, noteId: string) {
    if (this.recording.get(userId)?.noteId === noteId) this.recording.delete(userId);
  }

  /** True while a note is recording; the voice-command bridge must not act on dictation. */
  isRecording(userId: string): boolean {
    const r = this.recording.get(userId);
    if (r && r.until < this.now()) this.recording.delete(userId);
    return !!r && r.until >= this.now();
  }
}

// ------------------------------------------------- live stop-phrase check

const LIVE_MARK = 'You check a short audio window from a voice note recording.';
const LIVE_SYSTEM = `${LIVE_MARK}
The speaker ends a note by saying "${STOP_PHRASE}" (or something that sounds like it: "stop recording", "stop recording, Meta", "stop recording metta").
Answer only whether the window contains that stop phrase spoken as a command, and where it starts in seconds from the start of the window.
Do not transcribe anything else.`;

export function buildLiveRequest(model: string, wavBase64: string): CompletionRequest {
  return {
    model,
    system: LIVE_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Audio window:' }, { type: 'audio', format: 'wav', data: wavBase64 }] }],
    responseSchema: {
      name: 'stop_check',
      schema: {
        type: 'object',
        properties: { stop: { type: 'boolean' }, start_seconds: { type: ['number', 'null'] } },
        required: ['stop', 'start_seconds'],
        additionalProperties: false,
      },
    },
    maxOutputTokens: 40,
  };
}

export function parseLive(text: string): { stop: boolean; startSeconds: number | null } {
  try {
    const m = /\{[\s\S]*\}/.exec(text);
    const o = JSON.parse(m?.[0] ?? text) as { stop?: unknown; start_seconds?: unknown };
    const start = typeof o.start_seconds === 'number' && Number.isFinite(o.start_seconds) && o.start_seconds >= 0 ? o.start_seconds : null;
    return { stop: o.stop === true, startSeconds: o.stop === true ? start : null };
  } catch {
    return { stop: false, startSeconds: null };
  }
}

export async function checkStopPhrase(
  models: ModelRegistry,
  spec: string,
  wavBase64: string,
  signal?: AbortSignal,
): Promise<{ stop: boolean; startSeconds: number | null; model: string; costUsd: number | null }> {
  const { provider, spec: s } = models.resolve(spec);
  if (!provider.capabilities(s.model).audio) throw new ModelError('bad_request', `Model "${s.id}" doesn't accept audio; change NOTES_LIVE_MODEL`);
  const req = buildLiveRequest(s.model, wavBase64);
  const out = await provider.complete(signal ? { ...req, signal } : req);
  return { ...parseLive(out.text), model: `${out.provider}:${out.model}`, costUsd: out.usage.costUsd };
}

export const isLiveRequest = (req: CompletionRequest) => req.system.startsWith(LIVE_MARK);

/**
 * Free "fake:" stand-in. It can't hear, so tests and scripts mark the window:
 * a WAV whose bytes contain the ASCII stop phrase counts as "said it".
 */
export function fakeLive(req: CompletionRequest): FakeReply {
  const audio = req.messages.at(-1)?.content.find((p) => p.type === 'audio');
  const bytes = audio && audio.type === 'audio' ? Buffer.from(audio.data, 'base64').toString('latin1').toLowerCase() : '';
  const at = bytes.indexOf(STOP_PHRASE);
  return JSON.stringify({ stop: at >= 0, start_seconds: at >= 0 ? Math.max(0, (at - 44) / 32_000) : null });
}

// ------------------------------------------------------------- WAV sniff

/** RIFF/WAVE header with PCM data; returns duration when the header is readable. */
export function sniffWav(head: Buffer): boolean {
  return head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WAVE';
}

export function sniffMp3(head: Buffer): boolean {
  return head.subarray(0, 3).toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0);
}
