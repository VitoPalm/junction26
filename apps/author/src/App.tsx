import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { HashRouter, Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { CAPABILITIES, LIMITATIONS } from '@junction26/applet-format';
import { createApi, defaultServer, devToken, isNative, loadSession, saveSession, type Api, type Project, type Session } from './api.ts';
import { ProjectScreen } from './ProjectScreen.tsx';
import { GlassesScreen } from './GlassesScreen.tsx';
import { stopSessionRecorder } from './recorder.ts';
import { RecorderPill, RecorderScreen } from './Notes.tsx';

interface Ctx {
  session: Session;
  api: Api;
  signOut(): void;
}
const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

export function App({ account }: { account?: Ctx } = {}) {
  const [session, setSession] = useState<Session | null>(loadSession);
  // Stable per session: screens depend on `api` in effects.
  const devCtx = useMemo<Ctx | null>(
    () =>
      session && {
        session,
        api: createApi(session),
        signOut: () => {
          void stopSessionRecorder().finally(() => { saveSession(null); setSession(null); });
        },
      },
    [session],
  );
  const ctx = account ?? devCtx;
  if (!ctx) {
    return (
      <SignIn
        onDone={(s) => {
          saveSession(s);
          setSession(s);
        }}
      />
    );
  }
  return (
    <AppCtx.Provider value={ctx}>
      {/* Hash routing works the same on the web and inside the native shells. */}
      <HashRouter>
        <RecorderPill />
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/p/:projectId" element={<ProjectScreen />} />
          <Route path="/glasses" element={<GlassesScreen />} />
          <Route path="/recorder" element={<RecorderScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AppCtx.Provider>
  );
}

function SignIn({ onDone }: { onDone: (s: Session) => void }) {
  const [name, setName] = useState('');
  const [server, setServer] = useState(defaultServer());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const s: Session = { server: server.trim().replace(/\/$/, ''), token: devToken(name), name: name.trim() };
    setBusy(true);
    setError(null);
    try {
      await createApi(s).me();
      onDone(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="page narrow">
      <div className="hero">
        <img src="./icon.png" alt="" width={56} height={56} />
        <h1>Applets</h1>
        <p className="muted">Small personal apps for your Meta Ray-Ban Display glasses.</p>
      </div>
      <form className="card stack" onSubmit={submit}>
        <label className="field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" placeholder="e.g. alex" />
        </label>
        {(isNative || server) && (
          <label className="field">
            <span>Server</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} inputMode="url" placeholder="https://your-backend.example" autoCapitalize="off" />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || !name.trim()}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
        <p className="tiny muted">Development sign-in: anyone with the same name shares the library. Real accounts come later.</p>
      </form>
    </main>
  );
}

const WELCOME_KEY = 'j26.welcomed';

function Library() {
  const { api, session, signOut } = useApp();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [welcome, setWelcome] = useState(() => {
    try {
      return !localStorage.getItem(WELCOME_KEY);
    } catch {
      return false;
    }
  });
  useEffect(() => {
    api.projects().then((r) => setProjects(r.projects), (e: Error) => setError(e.message));
  }, [api]);
  const create = async () => {
    try {
      const { project } = await api.createProject('New applet');
      navigate(`/p/${project.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <main className="page">
      <header className="bar">
        <h1>Your applets</h1>
        <div className="row">
          <Link className="ghost" to="/glasses">Glasses</Link>
          <Link className="ghost" to="/recorder">Recorder</Link>
          <button className="ghost" onClick={() => setWelcome(true)} aria-label="What can I make?">?</button>
          <button className="ghost" onClick={signOut} title={`Signed in as ${session.name}`}>Sign out</button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {!projects && !error && <p className="muted">Loading…</p>}
      {projects?.length === 0 && (
        <div className="empty">
          <p>Nothing yet. Tap <b>+</b> and describe what you need, like “a row counter for crochet” or “guide me through this manual”.</p>
        </div>
      )}
      <ul className="list">
        {projects?.map((p) => (
          <li key={p.id}>
            <Link to={`/p/${p.id}`} className="card item">
              <span className="title">{p.title}</span>
              <span className={p.currentReleaseId ? 'badge ok' : 'badge'}>{p.currentReleaseId ? 'On glasses' : 'Draft'}</span>
            </Link>
          </li>
        ))}
      </ul>
      <button className="fab" onClick={create} aria-label="New applet">+</button>
      {welcome && (
        <Modal
          onClose={() => {
            try {
              localStorage.setItem(WELCOME_KEY, '1');
            } catch {
              /* ignore */
            }
            setWelcome(false);
          }}
        >
          <h2>What you can make</h2>
          <ul className="caps">
            {CAPABILITIES.map((c) => (
              <li key={c.id}>
                <b>{c.title}</b>
                <span>{c.description}</span>
                <span className="muted tiny">e.g. “{c.examples[0]}”</span>
              </li>
            ))}
          </ul>
          <h3>Not possible (on purpose)</h3>
          <ul className="limits">
            {LIMITATIONS.map((l) => (
              <li key={l.id}>{l.description}</li>
            ))}
          </ul>
          <p className="muted tiny">On the glasses you use applets with the Neural Band (move and pinch) or by saying “Hey Meta, …”.</p>
        </Modal>
      )}
    </main>
  );
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" onClick={(e) => e.stopPropagation()}>
        {children}
        <button className="primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}
