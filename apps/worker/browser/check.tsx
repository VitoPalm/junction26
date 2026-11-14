import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { ReactRouterNavigationProvider } from '@wearables-ui-toolkit/mrbd/react-router';
import { GlassesRoot } from '@junction26/glasses-ui';
import type { AppletDefinition } from '@junction26/applet-format';
import { AppletScreen, type AppletSession, type Screen } from '@junction26/applet-renderer';
import { initialState } from '@junction26/applet-runtime';
import '@junction26/glasses-ui/styles.css';
declare global {
  interface Window {
    renderFit: (definition: AppletDefinition, screen: Screen, cursor?: number) => void;
  }
}
const root = createRoot(document.getElementById('root')!);
let serial = 0;
window.renderFit = (definition, screen, cursor = 0) => {
  const state = initialState(definition);
  if (screen.kind === 'view') {
    const view = definition.views.find((v) => v.id === screen.viewId);
    if (view?.kind === 'sequence') state.values[view.cursor] = cursor;
  }
  const session: AppletSession = {
    definition,
    state,
    notice: null,
    run: async () => ({ ok: true, state, summary: 'Fit preview', changed: [] }),
    step: async () => {},
    setView: () => {},
    clearNotice: () => {},
  };
  flushSync(() =>
    root.render(
      <MemoryRouter key={++serial}>
        <ReactRouterNavigationProvider>
          <GlassesRoot>
            <AppletScreen session={session} screen={screen} onOpen={() => {}} />
          </GlassesRoot>
        </ReactRouterNavigationProvider>
      </MemoryRouter>,
    ),
  );
};
