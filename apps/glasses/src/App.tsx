import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes, useLocation, useNavigate, useParams, type NavigateFunction } from 'react-router-dom';
import { ReactRouterPageTransition } from '@wearables-ui-toolkit/mrbd/react-router';
import { Button } from '@wearables-ui-toolkit/mrbd';
import { ChoiceScreen, ContentScreen, TextBlock, type GlassesAction } from '@junction26/glasses-ui';
import { AppletScreen, ButtonList, hasMenu, registerAppletTools, useAppletSession, type AppletSession, type Screen, type ToolHost } from '@junction26/applet-renderer';
import type { AppletDefinition } from '@junction26/applet-format';
import type { AppletState } from '@junction26/applet-runtime';
import { store, type InstalledApplet } from './store.ts';
import { installDemos, library, loadState, markOpened, pair, pairing, saveState, sync } from './sync.ts';
import { setVoiceEnabled, startVoiceBridge, useVoiceChip, useVoicePref } from './voice.ts';
import { useVoiceNotes } from './notes.ts';

const HOME_COUNT = 3;

/**
 * The router's home is "/glasses" (no slash), but the service worker's scope
 * is "/glasses/". Keep the URL inside the scope so a reload on the home screen
 * is still served offline.
 */
function useCanonicalHomeUrl() {
  const location = useLocation();
  useEffect(() => {
    const base = import.meta.env.BASE_URL; // "/glasses/"
    if (window.location.pathname === base.replace(/\/$/, '')) {
      history.replaceState(history.state, '', base + window.location.search + window.location.hash);
    }
  }, [location]);
}

export function GlassesApp() {
  useCanonicalHomeUrl();
  return (
    <>
    <VoiceChipView />
    <ReactRouterPageTransition>
      {({ location }) => (
        <Routes location={location}>
          <Route path="/" element={<Home />} />
          <Route path="/older" element={<Older />} />
          <Route path="/pair" element={<Pair />} />
          <Route path="/a/:projectId" element={<AppletRoute key={location.pathname} />} />
          <Route path="/a/:projectId/:viewId" element={<AppletRoute key={location.pathname} />} />
          <Route path="*" element={<Home />} />
        </Routes>
      )}
    </ReactRouterPageTransition>
    </>
  );
}

/** What the voice bridge heard and did; bright text only (additive display). */
function VoiceChipView() {
  const chip = useVoiceChip();
  if (!chip) return null;
  return (
    <div className="j26-voice-chip" role="status" aria-live="polite">
      <div className="j26-voice-heard">“{chip.heard}”</div>
      <div className={chip.ok ? 'j26-voice-result' : 'j26-voice-result j26-voice-error'}>{chip.result}</div>
    </div>
  );
}

/**
 * Opens an applet where the wearer left off. Multi-view applets push the menu
 * first, so Back from the resumed view lands on the menu, then the library.
 */
async function openApplet(navigate: NavigateFunction, a: InstalledApplet) {
  const saved = await loadState(a);
  await markOpened(a);
  navigate(`/a/${a.projectId}`);
  if (hasMenu(a.definition)) navigate(`/a/${a.projectId}/${saved.state.view}`);
}

function useLibrary() {
  const [items, setItems] = useState<InstalledApplet[] | null>(null);
  const [paired, setPaired] = useState(false);
  const reload = useCallback(async () => {
    const p = await pairing();
    let list = await library();
    if (!p && list.length === 0) {
      await installDemos();
      list = await library();
    }
    setPaired(!!p);
    setItems(list);
  }, []);
  useEffect(() => void reload(), [reload]);
  return { items, paired, reload };
}

function Home() {
  const navigate = useNavigate();
  const { items, paired, reload } = useLibrary();
  const [status, setStatus] = useState<string | null>(null);
  const voice = useVoicePref();
  const busy = useRef(false);

  const doSync = async () => {
    if (busy.current) return;
    busy.current = true;
    setStatus('Syncing…');
    try {
      const r = await sync();
      setStatus(r.message);
      await reload();
    } catch {
      setStatus('Sync failed. Check the connection.');
    } finally {
      busy.current = false;
    }
  };

  if (!items) return <ContentScreen><TextBlock text="Loading…" /></ContentScreen>;
  const latest = items.slice(0, HOME_COUNT);
  const actions: GlassesAction[] = [];
  if (items.length > HOME_COUNT) actions.push({ id: 'home.older', label: 'Older', onActivate: () => navigate('/older') });
  actions.push(paired ? { id: 'home.sync', label: 'Sync', onActivate: () => void doSync() } : { id: 'home.pair', label: 'Pair phone', onActivate: () => navigate('/pair') });
  // Phone voice bridge (docs/voice-fallback.md): needs a paired device session.
  if (paired) actions.push({ id: 'home.voice', label: voice ? 'Voice off' : 'Voice on', onActivate: () => { setVoiceEnabled(!voice); setStatus(voice ? 'Voice bridge off' : 'Voice bridge on'); } });

  return (
    <ContentScreen title={status ?? 'Your applets'} actions={actions}>
      {latest.length ? (
        <ButtonList items={latest.map((a) => ({ id: a.projectId, label: a.title, hint: a.demo ? 'Example' : undefined, onActivate: () => void openApplet(navigate, a) }))} />
      ) : (
        <TextBlock text="Nothing here yet. Make an applet in the phone app, then choose Sync." />
      )}
    </ContentScreen>
  );
}

function Older() {
  const navigate = useNavigate();
  const { items } = useLibrary();
  if (!items) return <ContentScreen><TextBlock text="Loading…" /></ContentScreen>;
  return (
    <ChoiceScreen
      title="Older applets"
      items={items.slice(HOME_COUNT).map((a) => ({ id: a.projectId, label: a.title }))}
      onChoose={(id) => { const a = items.find((x) => x.projectId === id); if (a) void openApplet(navigate, a); }}
    />
  );
}

/** Reads a pairing code from the URL (QR / link from the phone): /glasses/#pair=XXXX-XXXX */
export function pairCodeFromHash(): string | null {
  const m = /[#&]pair=([^&]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]!) : null;
}

function Pair() {
  const navigate = useNavigate();
  const [code, setCode] = useState(pairCodeFromHash() ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async (value = code) => {
    if (!value.trim()) return setMsg('Type the code first.');
    setMsg('Pairing…');
    try {
      await pair(value);
      history.replaceState(null, '', location.pathname);
      setMsg(null);
      await sync().catch(() => null);
      navigate('/', { replace: true });
    } catch {
      setMsg('That code didn’t work. Make a new one.');
    }
  };
  useEffect(() => {
    if (pairCodeFromHash()) void submit(pairCodeFromHash()!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <ContentScreen title="Pair with your phone">
      <TextBlock text="In the phone app, open Glasses and get a code. Enter it here." hint={msg ?? undefined} />
      <div data-g-fit-content className="j26-pair">
        {/* Focusing and selecting opens Meta's dictation/handwriting composer. */}
        <input className="j26-code" value={code} aria-label="Pairing code" placeholder="ABCD-EFGH" autoComplete="off" onChange={(e) => setCode(e.target.value)} onInput={(e) => setCode((e.target as HTMLInputElement).value)} />
        <Button title="Pair" alwaysShowText onClick={() => void submit()} />
      </div>
    </ContentScreen>
  );
}

function AppletRoute() {
  const { projectId = '' } = useParams();
  const [loaded, setLoaded] = useState<{ applet: InstalledApplet; state: AppletState } | null | 'missing'>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const applet = await store.applet(projectId);
      if (!applet) return alive && setLoaded('missing');
      const saved = await loadState(applet);
      if (alive) setLoaded({ applet, state: saved.state });
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);
  if (loaded === 'missing') return <ContentScreen title="Not found"><TextBlock text="This applet isn’t on these glasses. Try Sync." /></ContentScreen>;
  if (!loaded) return <ContentScreen><TextBlock text="Opening…" /></ContentScreen>;
  return <AppletHost applet={loaded.applet} initial={loaded.state} />;
}

function AppletHost({ applet, initial }: { applet: InstalledApplet; initial: AppletState }) {
  const { viewId } = useParams();
  const navigate = useNavigate();
  const def = applet.definition;
  const persist = useCallback((s: AppletState) => saveState(applet.projectId, s), [applet.projectId]);
  const init = useMemo(() => initial, [initial]);
  const session = useAppletSession(def, init, persist);
  const sessionRef = useRef<AppletSession>(session);
  sessionRef.current = session;

  const screen: Screen = viewId ? { kind: 'view', viewId } : hasMenu(def) ? { kind: 'menu' } : { kind: 'view', viewId: session.state.view };
  const currentView = screen.kind === 'view' ? screen.viewId : null;
  const viewRef = useRef(currentView);
  viewRef.current = currentView;

  const open = useCallback((s: Screen) => {
    if (s.kind === 'view') navigate(`/a/${applet.projectId}/${s.viewId}`);
    else navigate(`/a/${applet.projectId}`);
  }, [navigate, applet.projectId]);

  useEffect(() => {
    if (currentView && currentView !== session.state.view) session.setView(currentView);
  }, [currentView, session]);

  const notes = useVoiceNotes(applet, () => sessionRef.current);

  // Voice tools exist only while this applet is open.
  useAppletTools(applet.projectId, def, { session: () => sessionRef.current, openView: (id) => open({ kind: 'view', viewId: id }), currentView: () => viewRef.current, notes: notes.host });

  return <AppletScreen session={session} screen={screen} onOpen={open} notes={notes.binding} />;
}

/**
 * One registration per open applet, not per route: page transitions keep the
 * old and new route mounted together, and WebMCP rejects duplicate names. The
 * newest host receives calls; tools go away shortly after the last host leaves.
 */
const activeTools: { key: string | null; ac: AbortController | null; hosts: ToolHost[]; timer: number } = { key: null, ac: null, hosts: [], timer: 0 };

function useAppletTools(projectId: string, def: AppletDefinition, host: ToolHost) {
  const hostRef = useRef(host);
  hostRef.current = host;
  useEffect(() => {
    const key = `${projectId}:${JSON.stringify(def).length}:${def.title}`;
    const proxy: ToolHost = {
      session: () => hostRef.current.session(),
      openView: (v) => hostRef.current.openView(v),
      currentView: () => hostRef.current.currentView(),
      notes: { start: (a) => hostRef.current.notes!.start(a), stop: () => hostRef.current.notes!.stop() },
    };
    clearTimeout(activeTools.timer);
    if (activeTools.key !== key) {
      activeTools.ac?.abort();
      activeTools.ac = new AbortController();
      activeTools.key = key;
      activeTools.hosts = [];
      const latest: ToolHost = {
        session: () => activeTools.hosts.at(-1)!.session(),
        openView: (v) => activeTools.hosts.at(-1)!.openView(v),
        currentView: () => activeTools.hosts.at(-1)?.currentView() ?? null,
        notes: { start: (a) => activeTools.hosts.at(-1)!.notes!.start(a), stop: () => activeTools.hosts.at(-1)!.notes!.stop() },
      };
      registerAppletTools(def, latest, activeTools.ac.signal);
      // Same tools, same single owner: the phone voice bridge, when switched on.
      startVoiceBridge(projectId, def, latest, activeTools.ac.signal);
    }
    activeTools.hosts.push(proxy);
    return () => {
      activeTools.hosts = activeTools.hosts.filter((h) => h !== proxy);
      if (!activeTools.hosts.length) {
        activeTools.timer = window.setTimeout(() => {
          if (activeTools.hosts.length) return;
          activeTools.ac?.abort();
          activeTools.ac = null;
          activeTools.key = null;
        }, 50);
      }
    };
  }, [projectId, def]);
}
