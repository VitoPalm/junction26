/**
 * The glasses renderer at 600×600, inside an iframe of the authoring app.
 * Same validation, runtime and components as the glasses; preview state lives
 * only in memory and never touches the wearer's real state.
 *
 * Protocol (postMessage, same origin):
 *   parent → { type: 'j26.preview.load', definition, key }   (key change = reset)
 *   parent → { type: 'j26.preview.menu' }                     (Back)
 *   parent → { type: 'j26.preview.tool', name, args, id }     (simulated "Hey Meta")
 *   preview → { type: 'j26.preview.ready' } / { type: 'j26.preview.tool.result', id, result }
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ReactRouterNavigationProvider } from '@wearables-ui-toolkit/mrbd/react-router';
import { ContentScreen, GlassesRoot, TextBlock } from '@junction26/glasses-ui';
import { validateDefinition, type AppletDefinition } from '@junction26/applet-format';
import { initialState } from '@junction26/applet-runtime';
import { AppletScreen, appletTools, hasMenu, useAppletSession, type AppletSession, type Screen } from '@junction26/applet-renderer';
import '@junction26/glasses-ui/styles.css';

type Loaded = { def: AppletDefinition; key: string } | { error: string } | null;

function Preview() {
  const [loaded, setLoaded] = useState<Loaded>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== 'j26.preview.load') return;
      const r = validateDefinition(e.data.definition);
      setLoaded(r.ok ? { def: r.definition, key: String(e.data.key) } : { error: `${r.issues.length} problem(s): ${r.issues[0]?.path} ${r.issues[0]?.message}` });
    };
    addEventListener('message', onMessage);
    parent.postMessage({ type: 'j26.preview.ready' }, location.origin);
    return () => removeEventListener('message', onMessage);
  }, []);
  if (!loaded) return <ContentScreen><TextBlock text="Nothing to preview yet." /></ContentScreen>;
  if ('error' in loaded) return <ContentScreen title="Can't preview"><TextBlock text={loaded.error.slice(0, 120)} /></ContentScreen>;
  return <Host key={loaded.key} def={loaded.def} />;
}

function Host({ def }: { def: AppletDefinition }) {
  const initial = useMemo(() => initialState(def, 'preview'), [def]);
  const session = useAppletSession(def, initial);
  const ref = useRef<AppletSession>(session);
  ref.current = session;
  const [screen, setScreen] = useState<Screen>(hasMenu(def) ? { kind: 'menu' } : { kind: 'view', viewId: initial.view });
  const screenRef = useRef(screen);
  screenRef.current = screen;

  useEffect(() => {
    const tools = appletTools(def, {
      session: () => ref.current,
      openView: (viewId) => setScreen({ kind: 'view', viewId }),
      currentView: () => (screenRef.current.kind === 'view' ? screenRef.current.viewId : null),
    });
    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type === 'j26.preview.menu' && hasMenu(def)) setScreen({ kind: 'menu' });
      if (e.data?.type === 'j26.preview.tool') {
        const tool = tools.find((t) => t.name === e.data.name);
        const result = tool ? await tool.execute(e.data.args ?? {}) : { error: 'unknown_tool' };
        parent.postMessage({ type: 'j26.preview.tool.result', id: e.data.id, result }, location.origin);
      }
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [def]);

  return <AppletScreen session={session} screen={screen} onOpen={setScreen} />;
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <ReactRouterNavigationProvider>
      <GlassesRoot>
        <Preview />
      </GlassesRoot>
    </ReactRouterNavigationProvider>
  </MemoryRouter>,
);
