import { useEffect, useState } from 'react';
import { isNative, type Api } from './api.ts';
import { NativeNoteRecorder } from './native-recorder.ts';
import { concat, Downsampler, encodeWav, endsWithStopPhrase, findStopCut, frameRms, hasSpeech, RATE } from './audio.ts';

/**
 * Phone note recorder (docs/voice-notes.md). While it is on, the phone keeps
 * the microphone open (the glasses' mics when they are the audio route) and
 * listens for `start`/`stop` from the API. The glasses start a note ("Hey
 * Meta, record a note" or a band pinch); we record, listen for "stop
 * recording meta", cut the phrase off, and upload a 16 kHz WAV.
 *
 * Live stop detection, cheapest first:
 * - device: the platform speech recogniser (Web Speech API; on-device or the
 *   platform's own free service). Its text is used only to spot the phrase.
 * - cloud: short windows to /v1/notes/:id/live (NOTES_LIVE_MODEL), only after
 *   a burst of speech followed by a pause, so silence costs nothing.
 * - off: stop with the band or "Hey Meta, stop the note".
 *
 * Unverified on the device: whether the browser picks the glasses' Bluetooth
 * mic, and whether speech recognition and recording can share the mic on
 * every phone. A web page also stops recording when the phone locks.
 */

export type LiveMode = 'auto' | 'device' | 'cloud' | 'off';
type EndReason = 'phrase' | 'band' | 'voice' | 'timeout' | 'interrupted' | 'disconnect';

export interface RecorderState {
  phase: 'off' | 'arming' | 'ready' | 'recording' | 'saving' | 'error';
  connected: boolean;
  liveMode: LiveMode;
  /** The detector actually in use for the current note. */
  detector: 'device' | 'cloud' | 'off' | null;
  note: { id: string; pageLabel: string; startedAt: number; maxSeconds: number } | null;
  message: string | null;
  pending: number;
  lastSaved: { pageLabel: string; at: number } | null;
  micLabel: string | null;
}

const PRE_ROLL = Math.round(RATE * 0.3);
const LIVE_EVERY_MS = 700;
const LIVE_WINDOW = RATE * 5;
const MODE_KEY = 'j26.noteLiveMode';

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('j26-tap', Tap);
`;

type SpeechRec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>; resultIndex: number }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
const SpeechRecognitionCtor = (): (new () => SpeechRec) | null =>
  typeof window === 'undefined' ? null : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null);

export const deviceRecognitionAvailable = () => isNative || SpeechRecognitionCtor() !== null;

// ------------------------------------------------------- pending uploads

interface Pending {
  id: string;
  wav: Blob;
  durationMs: number;
  endReason: EndReason;
  pageLabel: string;
}

/** Recordings wait in IndexedDB until the server confirms them, so a dead connection loses nothing. */
const queue = {
  db: null as Promise<IDBDatabase> | null,
  open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const r = indexedDB.open('j26-notes', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('pending', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.db;
  },
  async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction('pending', mode).objectStore('pending'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  put: (p: Pending) => queue.run('readwrite', (s) => s.put(p)),
  all: () => queue.run<Pending[]>('readonly', (s) => s.getAll() as IDBRequest<Pending[]>),
  delete: (id: string) => queue.run('readwrite', (s) => s.delete(id)),
};

// ------------------------------------------------------------ recorder

export class NoteRecorder {
  state: RecorderState = {
    phase: 'off',
    connected: false,
    liveMode: readMode(),
    detector: null,
    note: null,
    message: null,
    pending: 0,
    lastSaved: null,
    micLabel: null,
  };
  private readonly api: Api;
  private readonly listeners = new Set<(s: RecorderState) => void>();
  private media: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private down: Downsampler | null = null;
  private ring: Float32Array[] = [];
  private ringLen = 0;
  private chunks: Float32Array[] = [];
  private noteLen = 0;
  private events: AbortController | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private rec: SpeechRec | null = null;
  private stopAt: number | null = null;
  private liveTimer = 0;
  private limitTimer = 0;
  private liveBusy = false;
  private heardAny = false;
  private watchdog = 0;
  private flushTimer = 0;
  private flushDelay = 3000;

  constructor(api: Api) {
    this.api = api;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.flush());
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.state.phase !== 'off') void this.lockScreen();
      });
      void this.refreshPending().then(() => this.flush());
    }
  }

  subscribe(fn: (s: RecorderState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => void this.listeners.delete(fn);
  }

  private set(patch: Partial<RecorderState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  setLiveMode(mode: LiveMode) {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {}
    this.set({ liveMode: mode });
  }

  /** Must run from a tap (iOS only starts audio from a user gesture). */
  async turnOn() {
    if (this.state.phase !== 'off' && this.state.phase !== 'error') return;
    this.set({ phase: 'arming', message: null });
    try {
      this.media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const track = this.media.getAudioTracks()[0];
      track?.addEventListener('ended', () => this.onMicLost());
      this.ctx = new AudioContext();
      await this.ctx.resume();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const src = this.ctx.createMediaStreamSource(this.media);
      const tap = new AudioWorkletNode(this.ctx, 'j26-tap');
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      src.connect(tap).connect(mute).connect(this.ctx.destination);
      this.down = new Downsampler(this.ctx.sampleRate);
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.onPcm(e.data);
      this.set({ phase: 'ready', micLabel: track?.label || null });
      void this.lockScreen();
      void this.listen();
      void this.flush();
    } catch (e) {
      this.teardownAudio();
      this.set({ phase: 'error', message: (e as Error).name === 'NotAllowedError' ? 'Allow the microphone to record notes.' : `Microphone unavailable: ${(e as Error).message}` });
    }
  }

  async turnOff() {
    if (this.state.note) await this.finish('interrupted');
    this.events?.abort();
    this.events = null;
    this.teardownAudio();
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.set({ phase: 'off', connected: false, message: null, micLabel: null });
  }

  private teardownAudio() {
    this.media?.getTracks().forEach((t) => t.stop());
    this.media = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private async lockScreen() {
    try {
      this.wakeLock = (await (navigator as any).wakeLock?.request('screen')) ?? null;
    } catch {
      /* not supported or refused: the page must stay in front */
    }
  }

  private onMicLost() {
    if (this.state.note) void this.finish('interrupted');
    this.set({ phase: 'error', message: 'The microphone stopped. Turn the recorder on again.' });
    this.teardownAudio();
  }

  // ------------------------------------------------ audio in

  private onPcm(raw: Float32Array) {
    const pcm = this.down!.push(raw);
    if (!pcm.length) return;
    if (this.state.note) {
      this.chunks.push(pcm);
      this.noteLen += pcm.length;
    } else {
      // Keep a short pre-roll so the first word isn't clipped.
      this.ring.push(pcm);
      this.ringLen += pcm.length;
      while (this.ringLen - (this.ring[0]?.length ?? 0) >= PRE_ROLL) this.ringLen -= this.ring.shift()!.length;
    }
  }

  // ------------------------------------------------ events from the API

  private async listen() {
    let backoff = 1000;
    while (this.state.phase !== 'off' && this.state.phase !== 'error') {
      const ac = (this.events = new AbortController());
      try {
        const res = await this.api.fetchRaw('/v1/notes/recorder/events', { signal: ac.signal });
        this.set({ connected: true });
        backoff = 1000;
        const reader = res.body!.getReader();
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
            if (event === 'start') void this.begin(e.note);
            if (event === 'stop' && e.noteId === this.state.note?.id) void this.finish(e.reason === 'timeout' ? 'timeout' : e.reason === 'voice' ? 'voice' : 'band');
          }
        }
      } catch {
        if (ac.signal.aborted) return;
      }
      this.set({ connected: false });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  }

  // ------------------------------------------------ one note

  private async begin(note: { id: string; pageLabel: string; maxSeconds: number }) {
    if (this.state.note || this.state.phase !== 'ready') return; // one at a time; the glasses only allow one too
    this.chunks = [...this.ring];
    this.noteLen = this.ringLen;
    this.ring = [];
    this.ringLen = 0;
    this.stopAt = null;
    const mode = this.state.liveMode === 'auto' ? (deviceRecognitionAvailable() ? 'device' : 'cloud') : this.state.liveMode;
    this.set({ phase: 'recording', note: { id: note.id, pageLabel: note.pageLabel, startedAt: Date.now(), maxSeconds: note.maxSeconds }, detector: mode, message: null });
    try {
      await this.api.noteRecording(note.id);
    } catch {
      /* the glasses fall back to their own timeout; keep recording anyway */
    }
    if (mode === 'device') {
      this.startDeviceDetector();
      // Some recognisers fail silently (no results, no error). If it heard nothing while the
      // wearer clearly talked, switch to the cloud check rather than never stopping.
      this.heardAny = false;
      const started = Date.now();
      this.watchdog = window.setInterval(() => {
        if (this.heardAny || this.state.detector !== 'device') return clearInterval(this.watchdog);
        if (Date.now() - started >= 6000 && hasSpeech(concat(this.chunks, this.noteLen), 1000)) this.fallbackToCloud();
      }, 3000);
    }
    if (mode === 'cloud') this.liveTimer = window.setInterval(() => void this.cloudCheck(), LIVE_EVERY_MS);
    this.limitTimer = window.setTimeout(() => void this.finish('timeout'), note.maxSeconds * 1000);
  }

  private startDeviceDetector() {
    const Ctor = SpeechRecognitionCtor();
    if (!Ctor) return this.fallbackToCloud();
    const rec = (this.rec = new Ctor());
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (e) => {
      // Only the latest result matters: the phrase ends the note.
      this.heardAny = true;
      const last = e.results[e.results.length - 1];
      const text = last?.[0]?.transcript ?? '';
      if (endsWithStopPhrase(text)) {
        this.stopAt = this.noteLen;
        void this.finish('phrase');
      }
    };
    rec.onerror = (e) => {
      // Anything but "heard nothing yet" means this recogniser can't help: use the cloud check.
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.fallbackToCloud();
    };
    // Recognisers end after silence; keep listening while the note runs.
    rec.onend = () => {
      if (this.rec === rec && this.state.note) {
        try {
          rec.start();
        } catch {
          this.fallbackToCloud();
        }
      }
    };
    try {
      rec.start();
    } catch {
      this.fallbackToCloud();
    }
  }

  private fallbackToCloud() {
    if (!this.state.note || this.state.detector === 'cloud') return;
    const rec = this.rec;
    this.rec = null;
    try {
      rec?.abort();
    } catch {}
    this.set({ detector: 'cloud' });
    clearInterval(this.liveTimer);
    this.liveTimer = window.setInterval(() => void this.cloudCheck(), LIVE_EVERY_MS);
  }

  /** Only asks the model right after speech ended (a pause), never during silence. */
  private async cloudCheck() {
    const note = this.state.note;
    if (!note || this.liveBusy || this.noteLen < RATE * 1.5) return;
    const end = this.noteLen;
    const all = concat(this.chunks, end);
    const tail = frameRms(all.subarray(Math.max(0, end - RATE * 2)));
    if (tail.length < 50) return;
    const sorted = [...frameRms(all)].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
    const loud = Math.max(floor * 3, 0.01);
    const pause = [...tail.subarray(tail.length - 15)].every((r) => r < loud); // last 300 ms quiet
    const spoke = [...tail.subarray(0, tail.length - 15)].filter((r) => r >= loud).length >= 20; // ≥400 ms speech before
    if (!pause || !spoke) return;
    this.liveBusy = true;
    const start = Math.max(0, end - LIVE_WINDOW);
    try {
      const r = await this.api.liveCheck(note.id, new Blob([encodeWav(all.subarray(start, end))], { type: 'audio/wav' }));
      if (r.stop && this.state.note?.id === note.id) {
        this.stopAt = r.startSeconds !== null ? -(start + Math.round(r.startSeconds * RATE)) : end;
        void this.finish('phrase');
      }
    } catch {
      /* skip this window; the band and the time limit still work */
    } finally {
      this.liveBusy = false;
    }
  }

  private async finish(reason: EndReason) {
    const note = this.state.note;
    if (!note || this.state.phase === 'saving') return;
    clearInterval(this.liveTimer);
    clearTimeout(this.limitTimer);
    clearInterval(this.watchdog);
    const rec = this.rec;
    this.rec = null;
    try {
      rec?.abort();
    } catch {}
    this.set({ phase: 'saving' });
    let samples = concat(this.chunks, this.noteLen);
    this.chunks = [];
    this.noteLen = 0;
    if (reason === 'phrase' && this.stopAt !== null) {
      // Negative stopAt: the cloud model said exactly where the phrase starts.
      const cut = this.stopAt < 0 ? Math.max(0, -this.stopAt - Math.round(RATE * 0.15)) : findStopCut(samples, this.stopAt);
      samples = samples.subarray(0, cut);
    }
    const pageLabel = note.pageLabel;
    if (!hasSpeech(samples)) {
      await this.api.discardNote(note.id, 'too_short').catch(() => {});
      this.set({ phase: this.media ? 'ready' : 'off', note: null, detector: null, message: 'Too short, nothing saved.' });
      return;
    }
    const item: Pending = { id: note.id, wav: new Blob([encodeWav(samples)], { type: 'audio/wav' }), durationMs: (samples.length / RATE) * 1000, endReason: reason, pageLabel };
    try {
      await queue.put(item);
    } catch {
      /* IndexedDB unavailable (private mode): upload from memory only */
    }
    this.set({ phase: this.media ? 'ready' : 'off', note: null, detector: null });
    await this.upload(item);
    await this.refreshPending();
  }

  private async upload(item: Pending): Promise<boolean> {
    try {
      const result = await this.api.uploadNoteAudio(item.id, item.wav, item.durationMs, item.endReason);
      const digest = await crypto.subtle.digest('SHA-256', await item.wav.arrayBuffer());
      const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (result.note.audio?.sha256 !== hash) throw new Error('The server did not confirm this recording.');
      await queue.delete(item.id).catch(() => {});
      this.set({ lastSaved: { pageLabel: item.pageLabel, at: Date.now() }, message: null });
      this.flushDelay = 3000;
      return true;
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 404 || status === 413 || status === 415) {
        // The note is gone or the server will never take this file: don't retry forever.
        await queue.delete(item.id).catch(() => {});
        this.set({ message: 'A note couldn’t be saved.' });
        return false;
      }
      this.set({ message: 'Saved on this phone; uploading when online…' });
      clearTimeout(this.flushTimer);
      this.flushTimer = window.setTimeout(() => void this.flush(), this.flushDelay);
      this.flushDelay = Math.min(this.flushDelay * 2, 60_000);
      return false;
    }
  }

  private async refreshPending() {
    try {
      this.set({ pending: (await queue.all()).length });
    } catch {
      /* no IndexedDB */
    }
  }

  async flush() {
    let items: Pending[] = [];
    try {
      items = await queue.all();
    } catch {
      return;
    }
    for (const item of items) if (!(await this.upload(item))) break;
    await this.refreshPending();
  }
}

function readMode(): LiveMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'device' || v === 'cloud' || v === 'off' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

let instance: { api: Api; recorder: NoteRecorder | NativeNoteRecorder } | null = null;
/** One recorder per signed-in session; it keeps running across screens. */
export function recorderFor(api: Api): NoteRecorder | NativeNoteRecorder {
  if (instance?.api !== api) {
    void instance?.recorder.turnOff();
    instance = { api, recorder: isNative ? new NativeNoteRecorder(api) : new NoteRecorder(api) };
  }
  return instance.recorder;
}

export function useRecorder(api: Api): [RecorderState, NoteRecorder | NativeNoteRecorder] {
  const recorder = recorderFor(api);
  const [state, setState] = useState(recorder.state);
  useEffect(() => recorder.subscribe(setState), [recorder]);
  return [state, recorder];
}

export async function stopSessionRecorder() {
  const current = instance; instance = null;
  await current?.recorder.turnOff();
}
