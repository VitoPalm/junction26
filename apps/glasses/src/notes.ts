import { useEffect, useMemo, useState } from 'react';
import type { AppletDefinition } from '@junction26/applet-format';
import { describeState } from '@junction26/applet-runtime';
import { anchorKey, type AppletSession, type NoteAnchor, type NotesBinding, type NoteToolResult, type ToolHost } from '@junction26/applet-renderer';
import type { VoiceNoteStatus } from '@junction26/glasses-ui';
import { store, type InstalledApplet } from './store.ts';
import { pairing } from './sync.ts';

/**
 * Voice notes on the glasses (docs/voice-notes.md). The glasses never record:
 * they ask the API to start a note, the phone recorder records it, and a
 * per-note event stream tells us when it is recording, stopping and saved.
 * Network runs only while a note is in progress (an explicit user action),
 * and the stream closes whenever the app is hidden (platform rule).
 */

const API = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';
const START_TIMEOUT_MS = 15_000;
const SAVE_TIMEOUT_MS = 45_000;
const FLASH_MS = 3_000;

export const countsKey = (projectId: string) => `noteCounts:${projectId}`;

interface Active {
  noteId: string;
  projectId: string;
  key: string;
  status: VoiceNoteStatus;
  startedAt: number | null;
  message?: string;
  maxSeconds: number;
}

// One note at a time per glasses, shared by the UI and the WebMCP tools.
let active: Active | null = null;
let counts: Record<string, Record<string, number>> = {};
let stream: AbortController | null = null;
const timers = { flash: 0, limit: 0, watchdog: 0 };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function set(next: Active | null) {
  active = next;
  emit();
}

function flash(status: VoiceNoteStatus, message: string, key: string, projectId: string) {
  clearTimeout(timers.flash);
  set({ noteId: '', projectId, key, status, startedAt: null, message, maxSeconds: 0 });
  timers.flash = window.setTimeout(() => {
    if (active?.status === status && !active.noteId) set(null);
  }, FLASH_MS);
}

function finish(status: 'saved' | 'error', message?: string) {
  const a = active;
  closeStream();
  clearTimeout(timers.limit);
  clearTimeout(timers.watchdog);
  if (!a) return;
  if (status === 'saved') {
    const c = (counts[a.projectId] ??= {});
    c[a.key] = (c[a.key] ?? 0) + 1;
    void store.putMeta(countsKey(a.projectId), c).catch(() => {});
  }
  flash(status, message ?? (status === 'saved' ? 'Saved. See it in the phone app.' : 'The note didn’t save.'), a.key, a.projectId);
}

function closeStream() {
  stream?.abort();
  stream = null;
}

async function token(): Promise<string | null> {
  return (await pairing())?.token ?? null;
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const t = await token();
  if (!t) return { status: 401, json: null };
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Follows one note's server events until it is saved or discarded. */
async function follow(noteId: string) {
  closeStream();
  if (document.hidden || active?.noteId !== noteId) return;
  const t = await token();
  if (!t) return;
  const mine = (stream = new AbortController());
  try {
    const res = await fetch(`${API}/v1/notes/${noteId}/events`, { headers: { authorization: `Bearer ${t}` }, signal: mine.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
        if (!event || !data || active?.noteId !== noteId) continue;
        const e = JSON.parse(data) as { status?: string; startedAt?: string; reason?: string | null };
        if (event === 'status' && e.status === 'recording' && active.status === 'starting') onRecording(Date.now());
        if (event === 'recording') onRecording(e.startedAt ? Math.min(Date.now(), Date.parse(e.startedAt)) : Date.now());
        if (event === 'stopping') set({ ...active, status: 'saving' });
        if (event === 'saved') return finish('saved');
        if (event === 'discarded') return finish('error', e.reason === 'too_short' ? 'Too short, nothing saved.' : 'Note cancelled.');
      }
    }
  } catch {
    /* hidden, aborted or network blip: reconnect below while the note is live */
  }
  if (stream === mine) stream = null;
  if (active?.noteId === noteId && !document.hidden) window.setTimeout(() => void follow(noteId), 1500);
}

function onRecording(startedAt: number) {
  if (!active) return;
  clearTimeout(timers.watchdog);
  set({ ...active, status: 'recording', startedAt });
  // The phone enforces the limit too; this covers a phone that lost us.
  clearTimeout(timers.limit);
  timers.limit = window.setTimeout(() => void stopNote('timeout'), active.maxSeconds * 1000);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) closeStream();
  else if (active?.noteId) void follow(active.noteId);
});

export interface StartContext {
  applet: InstalledApplet;
  session: AppletSession;
}

export async function startNote(anchor: NoteAnchor, ctx: StartContext): Promise<NoteToolResult> {
  const key = anchorKey(anchor);
  const projectId = ctx.applet.projectId;
  if (active?.noteId) return { ok: false, code: 'already_recording', message: 'A note is already recording. Say “stop recording meta” first.' };
  if (ctx.applet.demo || !ctx.applet.releaseId) {
    const message = 'Notes work on applets from your phone';
    flash('unavailable', message, key, projectId);
    return { ok: false, code: 'demo_applet', message };
  }
  if (!(await token())) {
    flash('unavailable', 'Pair your phone first', key, projectId);
    return { ok: false, code: 'not_paired', message: 'Pair the glasses with your phone first.' };
  }
  const def: AppletDefinition = ctx.applet.definition;
  const view = def.views.find((v) => v.id === anchor.viewId);
  const noteId = crypto.randomUUID();
  clearTimeout(timers.flash);
  set({ noteId, projectId, key, status: 'starting', startedAt: null, maxSeconds: 300 });
  let r;
  try {
    r = await post('/v1/notes', {
      id: noteId,
      projectId,
      releaseId: ctx.applet.releaseId,
      viewId: anchor.viewId,
      stepId: anchor.stepId,
      pageLabel: anchor.pageLabel.slice(0, 120),
      noteLabel: view?.voiceNote?.label ?? null,
      stateSnapshot: describeState(def, ctx.session.state),
    });
  } catch {
    r = { status: 0, json: null };
  }
  if (r.status === 409 && r.json?.error?.code === 'no_recorder') {
    const message = 'Turn on the recorder in the phone app';
    flash('unavailable', message, key, projectId);
    return { ok: false, code: 'no_recorder', message: 'Open the Applets app on your phone and turn on the note recorder, then try again.' };
  }
  if (r.status !== 201 && r.status !== 200) {
    const message = r.status === 0 ? 'No connection' : 'Couldn’t start the note';
    flash('error', message, key, projectId);
    return { ok: false, code: 'start_failed', message: `${message}. Try again.` };
  }
  if (active?.noteId === noteId) set({ ...active, maxSeconds: r.json.maxSeconds ?? 300 });
  void follow(noteId);
  timers.watchdog = window.setTimeout(() => {
    if (active?.noteId === noteId && active.status === 'starting') {
      void post(`/v1/notes/${noteId}/discard`, { reason: 'phone' }).catch(() => {});
      finish('error', 'The phone didn’t start recording.');
    }
  }, START_TIMEOUT_MS);
  return { ok: true, message: 'Recording' };
}

export async function stopNote(reason: 'band' | 'voice' | 'timeout' = 'band'): Promise<NoteToolResult> {
  const a = active;
  if (!a?.noteId) return { ok: false, code: 'not_recording', message: 'No note is recording.' };
  clearTimeout(timers.limit);
  if (a.status === 'starting') {
    // Nothing recorded yet: cancel instead of waiting for audio that won't come.
    void post(`/v1/notes/${a.noteId}/discard`, { reason: 'too_short' }).catch(() => {});
    finish('error', 'Note cancelled.');
    return { ok: true, message: 'Cancelled' };
  }
  set({ ...a, status: 'saving' });
  try {
    await post(`/v1/notes/${a.noteId}/stop`, { reason });
  } catch {
    /* the phone still stops on the phrase or its own limit */
  }
  clearTimeout(timers.watchdog);
  timers.watchdog = window.setTimeout(() => {
    if (active?.noteId === a.noteId) finish('error', 'Still saving on the phone. Check the app.');
  }, SAVE_TIMEOUT_MS);
  return { ok: true, message: 'Saving' };
}

/** Counts per page from the last sync (plus notes saved since). */
async function loadCounts(projectId: string) {
  // Sync writes the server's counts here; saved notes add to it as they finish.
  const saved = await store.meta<Record<string, number>>(countsKey(projectId)).catch(() => undefined);
  counts[projectId] = { ...(saved ?? {}) };
  emit();
}

/** Binding for the renderer plus the note half of the WebMCP host, for one open applet. */
export function useVoiceNotes(applet: InstalledApplet, session: () => AppletSession): { binding: NotesBinding; host: NonNullable<ToolHost['notes']> } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    void loadCounts(applet.projectId);
    return () => void listeners.delete(l);
  }, [applet.projectId]);
  const host = useMemo<NonNullable<ToolHost['notes']>>(
    () => ({ start: (anchor) => startNote(anchor, { applet, session: session() }), stop: () => stopNote('voice') }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applet],
  );
  const mine = active && active.projectId === applet.projectId ? active : null;
  const binding: NotesBinding = {
    active: mine ? { key: mine.key, status: mine.status, startedAt: mine.startedAt, message: mine.message } : null,
    counts: counts[applet.projectId] ?? {},
    toggle: (anchor) => {
      if (active?.noteId) void stopNote('band');
      else void startNote(anchor, { applet, session: session() });
    },
  };
  return { binding, host };
}
