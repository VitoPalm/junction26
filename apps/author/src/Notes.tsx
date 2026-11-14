import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { isNative, type VoiceNote } from './api.ts';
import { useApp } from './App.tsx';
import { deviceRecognitionAvailable, useRecorder, type LiveMode } from './recorder.ts';

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Turn the phone recorder on and keep this app in front while recording notes. */
export function RecorderScreen() {
  const { api } = useApp();
  const [state, recorder] = useRecorder(api);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (state.phase !== 'recording') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state.phase]);
  const on = state.phase !== 'off' && state.phase !== 'error';
  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/" className="ghost" aria-label="Back">‹</Link>
        <h1 className="grow">Note recorder</h1>
      </header>
      <section className="card stack">
        <p>
          With the recorder on, say <b>“Hey Meta, record a note”</b> on an applet page with a note button, talk, then say{' '}
          <b>“stop recording meta”</b>. You can also pinch <b>Record note</b> / <b>Stop note</b> with the band.
        </p>
        {on ? (
          <button className="secondary" onClick={() => void recorder.turnOff()}>Turn recorder off</button>
        ) : (
          <button className="primary" onClick={() => void recorder.turnOn()}>Turn recorder on</button>
        )}
        <p className={`recorder-status ${state.phase}`} role="status" aria-live="polite">
          {state.phase === 'off' && 'Off'}
          {state.phase === 'arming' && 'Opening the microphone…'}
          {state.phase === 'ready' && (state.connected ? 'Ready. Waiting for your glasses.' : 'Connecting…')}
          {state.phase === 'recording' && state.note && (
            <>● Recording “{state.note.pageLabel}” · {elapsed(now - state.note.startedAt)}{state.detector === 'cloud' ? ' · cloud stop check' : state.detector === 'off' ? ' · stop with the band' : ''}</>
          )}
          {state.phase === 'saving' && 'Saving…'}
          {state.phase === 'error' && (state.message ?? 'Something went wrong.')}
        </p>
        {state.phase !== 'error' && state.message && <p className="muted">{state.message}</p>}
        {state.micLabel && <p className="tiny muted">Microphone: {state.micLabel}</p>}
        {state.pending > 0 && <p className="tiny muted">{state.pending} note(s) waiting to upload.</p>}
        {state.lastSaved && <p className="tiny muted">Last saved: {state.lastSaved.pageLabel}, {new Date(state.lastSaved.at).toLocaleTimeString()}</p>}
      </section>
      <section className="card stack">
        <h2>Listening for “stop recording meta”</h2>
        <label className="field">
          <span>How the phone spots the stop phrase</span>
          <select value={state.liveMode} onChange={(e) => recorder.setLiveMode(e.target.value as LiveMode)}>
            <option value="auto">Automatic (phone first, cloud if needed)</option>
            <option value="device" disabled={!deviceRecognitionAvailable()}>Phone speech recognition (free)</option>
            <option value="cloud">Cloud check (tiny cost, only after you pause)</option>
            <option value="off">Off: stop with the band or “Hey Meta, stop the note”</option>
          </select>
        </label>
        <p className="tiny muted">
          {isNative ? 'Turn on the recorder before locking your phone. It runs in the background for up to 12 hours; reopen the app to renew it. Bluetooth routing depends on your phone.' : 'Keep this app open with the screen on while recording: a web page can’t record in the background.'} Notes are capped at 5 minutes.
          The live check only listens for the stop phrase and is thrown away; the saved recording is transcribed properly afterwards.
        </p>
      </section>
    </main>
  );
}

/** Small always-visible status while the recorder is on. */
export function RecorderPill() {
  const { api } = useApp();
  const [state] = useRecorder(api);
  if (state.phase === 'off') return null;
  const label =
    state.phase === 'recording' ? '● Recording note' : state.phase === 'saving' ? 'Saving note…' : state.phase === 'error' ? 'Recorder stopped' : state.connected ? 'Recorder on' : 'Recorder connecting…';
  return (
    <Link to="/recorder" className={`recorder-pill ${state.phase}`}>
      {label}
    </Link>
  );
}

/** Notes for one applet, grouped by page (view, and step on guides), newest first. */
export function NotesPanel({ projectId, viewOrder }: { projectId: string; viewOrder: string[] }) {
  const { api } = useApp();
  const [notes, setNotes] = useState<VoiceNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.notes(projectId).then((r) => setNotes(r.notes), (e: Error) => setError(e.message)), [api, projectId]);
  useEffect(() => void load(), [load]);
  // Poll while something is being recorded or transcribed.
  const busy = notes?.some((n) => n.status === 'recording' || n.status === 'uploaded' || n.status === 'transcribing');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  const groups = useMemo(() => {
    const m = new Map<string, { label: string; viewId: string; notes: VoiceNote[] }>();
    for (const n of notes ?? []) {
      const key = n.stepId ? `${n.viewId}/${n.stepId}` : n.viewId;
      const g = m.get(key) ?? { label: n.pageLabel, viewId: n.viewId, notes: [] };
      g.notes.push(n);
      m.set(key, g);
    }
    const order = (v: string) => (viewOrder.indexOf(v) < 0 ? 999 : viewOrder.indexOf(v));
    return [...m.values()].sort((a, b) => order(a.viewId) - order(b.viewId) || b.notes[0]!.startedAt.localeCompare(a.notes[0]!.startedAt));
  }, [notes, viewOrder]);

  if (error) return <section className="notes"><p className="error">{error}</p></section>;
  if (!notes) return <section className="notes"><p className="muted">Loading notes…</p></section>;
  return (
    <section className="notes">
      {notes.length === 0 ? (
        <div className="empty">
          <p>No voice notes yet. On a page with a note button, say “Hey Meta, record a note”, talk, then say “stop recording meta”.</p>
          <p>
            The phone records them: <Link to="/recorder">turn on the note recorder</Link> first.
          </p>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.label + g.viewId} className="note-group">
            <h3>{g.label} <span className="muted tiny">· {g.notes.length}</span></h3>
            {g.notes.map((n) => <NoteCard key={n.id} note={n} onChange={load} />)}
          </div>
        ))
      )}
      <p className="tiny muted"><Link to="/recorder">Note recorder</Link></p>
    </section>
  );
}

function NoteCard({ note, onChange }: { note: VoiceNote; onChange: () => unknown }) {
  const { api } = useApp();
  const [src, setSrc] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => void (src && URL.revokeObjectURL(src)), [src]);

  const play = async () => {
    if (!note.audio || src) return;
    try {
      const res = await api.fetchRaw(note.audio.url);
      setSrc(URL.createObjectURL(await res.blob()));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const when = new Date(note.startedAt);
  const context = note.stateSnapshot
    ? Object.entries(note.stateSnapshot)
        .filter(([, v]) => typeof v !== 'object')
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(' · ')
    : '';
  return (
    <article className="card note">
      <div className="row tiny muted">
        <span className="grow">
          {when.toLocaleDateString()} {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {note.durationMs ? ` · ${elapsed(note.durationMs)}` : ''}
          {context ? ` · ${context}` : ''}
        </span>
        <StatusBadge note={note} />
      </div>
      {editing !== null ? (
        <div className="stack">
          <textarea rows={4} value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="Transcript" />
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void act(async () => { await api.editNote(note.id, editing); setEditing(null); })}>Save</button>
            <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <p className="transcript">
          {note.status === 'recording' ? <span className="muted">Recording now…</span>
            : note.transcript ? note.transcript
            : note.status === 'transcribed' ? <span className="muted">No speech found.</span>
            : note.status === 'failed' ? <span className="muted">Couldn’t transcribe this one.</span>
            : <span className="muted">Transcribing…</span>}
        </p>
      )}
      {note.audio && (src ? <audio controls autoPlay src={src} /> : <button className="secondary" onClick={() => void play()}>▶ Play</button>)}
      <div className="row">
        {note.audio && editing === null && <button className="link" onClick={() => setEditing(note.transcript ?? '')}>Edit</button>}
        {note.audio && (note.status === 'failed' || (note.status === 'transcribed' && !note.transcriptEdited)) && (
          <button className="link" disabled={busy} onClick={() => void act(() => api.retranscribe(note.id))}>Transcribe again</button>
        )}
        <span className="grow" />
        <button className="link danger" disabled={busy} onClick={() => confirm('Delete this note and its recording?') && void act(() => api.deleteNote(note.id))}>Delete</button>
      </div>
      {error && <p className="error tiny">{error}</p>}
    </article>
  );
}

function StatusBadge({ note }: { note: VoiceNote }) {
  if (note.status === 'transcribed') return note.transcriptEdited ? <span className="badge">Edited</span> : null;
  if (note.status === 'failed') return <span className="badge bad">Not transcribed</span>;
  if (note.status === 'recording') return <span className="badge rec">● Live</span>;
  return <span className="badge">Transcribing</span>;
}
