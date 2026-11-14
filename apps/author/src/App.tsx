import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HashRouter, Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { CAPABILITIES, LIMITATIONS } from '@junction26/applet-format';
import { createApi, defaultServer, devToken, isNative, loadSession, saveSession, type Api, type Device, type Project, type Session } from './api.ts';
import { ProjectScreen } from './ProjectScreen.tsx';
import { GlassesScreen } from './GlassesScreen.tsx';
import { BrandMark, CAPABILITY_ICONS, IconArrowRight, IconArrowUp, IconClip, IconClose, IconGlasses, IconHelp, IconLogout } from './icons.tsx';
import { FILE_ACCEPT, SUGGESTIONS, initialOf, relativeTime, setStartRequest, toneFor } from './ui.ts';

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
          saveSession(null);
          setSession(null);
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
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/p/:projectId" element={<ProjectScreen />} />
          <Route path="/glasses" element={<GlassesScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AppCtx.Provider>
  );
}

/** Brand block for the signed-out screens. */
export function Welcome({ children, footnote }: { children: ReactNode; footnote?: ReactNode }) {
  return (
    <main className="welcome">
      <div className="welcome-glow" aria-hidden />
      <div className="welcome-inner">
        <div className="welcome-hero">
          <BrandMark size={64} />
          <h1 className="display">Little apps for your glasses.</h1>
          <p className="lede">Describe what you need, or bring a pattern, recipe or manual. Use it hands-free on your Meta Ray-Ban Display.</p>
        </div>
        <div className="welcome-card">{children}</div>
        {footnote && <p className="tiny muted center">{footnote}</p>}
      </div>
    </main>
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
    <Welcome footnote="Development sign-in: anyone with the same name shares the library. Real accounts come later.">
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" placeholder="e.g. Alex" autoFocus />
        </label>
        {(isNative || server) && (
          <label className="field">
            <span>Server</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} inputMode="url" placeholder="https://your-backend.example" autoCapitalize="off" />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary lg" disabled={busy || !name.trim()}>
          {busy ? 'Checking…' : 'Get started'} {!busy && <IconArrowRight size={18} />}
        </button>
      </form>
    </Welcome>
  );
}

const WELCOME_KEY = 'j26.welcomed';

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 5 ? 'Hi' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const first = name.trim().split(/\s+/)[0];
  return first && first !== 'My' ? `${part}, ${first[0]!.toUpperCase()}${first.slice(1)}` : part;
}

function Library() {
  const { api, session } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
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
    api.devices().then((r) => setDevices(r.devices), () => setDevices(null));
  }, [api]);
  const paired = devices?.filter((d) => !d.revokedAt) ?? [];
  const live = projects?.filter((p) => p.currentReleaseId).length ?? 0;

  return (
    <main className="page">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Solutions home">
          <BrandMark size={32} />
          <span>Solutions</span>
        </Link>
        <span className="grow" />
        <Link className="icon-btn" to="/glasses" aria-label={paired.length ? 'Glasses (paired)' : 'Glasses'}>
          <IconGlasses size={22} />
          {paired.length > 0 && <span className="status-dot" />}
        </Link>
        <button className="icon-btn" onClick={() => setWelcome(true)} aria-label="What can I make?">
          <IconHelp size={21} />
        </button>
        <AccountMenu />
      </header>

      <section className="home-hero">
        <p className="eyebrow">{greeting(session.name)}</p>
        <h1 className="display">What do you need on your glasses?</h1>
        <HomeComposer />
      </section>

      {devices && paired.length === 0 && (
        <Link to="/glasses" className="nudge">
          <span className="nudge-icon"><IconGlasses size={24} /></span>
          <span className="grow">
            <b>Connect your glasses</b>
            <span className="muted">Two quick steps, then your solutions sync over.</span>
          </span>
          <IconArrowRight size={18} />
        </Link>
      )}

      <section className="library">
        <div className="section-head">
          <h2>Your solutions</h2>
          {projects && projects.length > 0 && (
            <span className="muted tiny">
              {projects.length} total{live ? ` · ${live} on glasses` : ''}
            </span>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {!projects && !error && (
          <div className="tiles">
            {[0, 1, 2, 3].map((i) => <div key={i} className="tile skeleton" />)}
          </div>
        )}
        {projects?.length === 0 && (
          <div className="empty-note">
            <p>Nothing here yet. Your first solution takes about a minute: describe it above, or pick one of the ideas.</p>
          </div>
        )}
        {projects && projects.length > 0 && (
          <ul className="tiles">
            {projects.map((p) => (
              <li key={p.id}>
                <Link to={`/p/${p.id}`} className="tile" data-tone={toneFor(p.id)}>
                  <span className="tile-mono" aria-hidden>{initialOf(p.title)}</span>
                  <span className="tile-body">
                    <span className="tile-title">{p.title}</span>
                    <span className="tile-meta">
                      {p.currentReleaseId ? (
                        <span className="pill live"><span className="live-dot" />On glasses</span>
                      ) : (
                        <span className="pill">Draft</span>
                      )}
                      <span className="tiny">{relativeTime(p.updatedAt)}</span>
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {welcome && (
        <Sheet
          title="What you can make"
          onClose={() => {
            try {
              localStorage.setItem(WELCOME_KEY, '1');
            } catch {
              /* ignore */
            }
            setWelcome(false);
          }}
          action="Let’s make one"
        >
          <p className="muted">Solutions are small, focused tools that run on your glasses, even offline. Control them with the Neural Band (move and pinch) or say “Hey Meta, …”.</p>
          <ul className="caps">
            {CAPABILITIES.map((c) => {
              const Icon = CAPABILITY_ICONS[c.id];
              return (
                <li key={c.id}>
                  <span className="cap-icon">{Icon ? <Icon size={22} /> : null}</span>
                  <span>
                    <b>{c.title}</b>
                    <span className="cap-desc">{c.description}</span>
                    <span className="cap-eg">“{c.examples[0]}”</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <details className="limits">
            <summary>What solutions can’t do, on purpose</summary>
            <ul>
              {LIMITATIONS.map((l) => (
                <li key={l.id}>{l.description}</li>
              ))}
            </ul>
          </details>
        </Sheet>
      )}
    </main>
  );
}

/** Describe it → a new project is created and generation starts right away. */
function HomeComposer() {
  const { api } = useApp();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useAutosize(text);

  const start = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject('New solution');
      setStartRequest({ projectId: project.id, text: body, files });
      navigate(`/p/${project.id}`);
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };

  return (
    <div className="home-composer-wrap">
      <form
        className="composer home"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <textarea
          ref={area}
          rows={2}
          value={text}
          placeholder="A row counter for my crochet blanket…"
          aria-label="Describe your solution"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(hover: hover)').matches) {
              e.preventDefault();
              void start();
            }
          }}
        />
        {files.length > 0 && (
          <div className="files">
            {files.map((f, i) => (
              <span key={i} className="file-chip">
                <span className="file-name">{f.name}</span>
                <button type="button" className="chip-x" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                  <IconClose size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button type="button" className="icon-btn soft" onClick={() => fileInput.current?.click()} aria-label="Attach a manual, recipe or pattern">
            <IconClip size={20} />
          </button>
          <span className="composer-hint">PDF, photo or text</span>
          <input ref={fileInput} type="file" hidden multiple accept={FILE_ACCEPT} onChange={(e) => { setFiles((f) => [...f, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} />
          <span className="grow" />
          <button className="send-btn" disabled={!text.trim() || busy} aria-label="Make it">
            {busy ? <span className="spinner" /> : <IconArrowUp size={20} />}
          </button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      <div className="ideas" aria-label="Ideas">
        {SUGGESTIONS.map((s) => (
          <button key={s.label} type="button" className="idea" onClick={() => { setText(s.text); area.current?.focus(); }}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Grows a textarea with its content (up to the CSS max-height). */
export function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

function AccountMenu() {
  const { session, signOut } = useApp();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('pointerdown', close);
    addEventListener('keydown', esc);
    return () => {
      removeEventListener('pointerdown', close);
      removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="account" ref={box}>
      <button className="avatar" onClick={() => setOpen((o) => !o)} aria-label="Account" aria-expanded={open}>
        {initialOf(session.name)}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <span className="avatar sm">{initialOf(session.name)}</span>
            <span className="grow">
              <b>{session.name}</b>
              <span className="tiny muted">Signed in</span>
            </span>
          </div>
          <Link to="/glasses" className="menu-item" role="menuitem"><IconGlasses size={18} /> Glasses</Link>
          <button className="menu-item" role="menuitem" onClick={signOut}><IconLogout size={18} /> Sign out</button>
        </div>
      )}
    </div>
  );
}

/** Bottom sheet on phones, centered dialog on wide screens. */
export function Sheet({ title, children, onClose, action = 'Got it' }: { title: string; children: ReactNode; onClose: () => void; action?: string | null }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      removeEventListener('keydown', esc);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconClose size={20} /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {action && <button className="primary lg wide" onClick={onClose}>{action}</button>}
      </div>
    </div>
  );
}
