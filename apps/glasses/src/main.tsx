import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ReactRouterNavigationProvider } from '@wearables-ui-toolkit/mrbd/react-router';
import { GlassesRoot } from '@junction26/glasses-ui';
import { installWebMcpStub } from '@junction26/applet-renderer';
import '@junction26/glasses-ui/styles.css';
import './glasses.css';
import { GlassesApp, pairCodeFromHash } from './App.tsx';
import { requestPersistence } from './store.ts';

// Dev only: a stand-in for Meta AI's document.modelContext (window.webmcp.call(...)).
if (import.meta.env.DEV && new URLSearchParams(location.search).has('webmcp')) installWebMcpStub();

// A pairing link from the phone opens the pairing screen directly.
if (pairCodeFromHash() && !location.pathname.endsWith('/pair')) history.replaceState(null, '', `${import.meta.env.BASE_URL}pair${location.hash}`);

void requestPersistence();

// Offline-first: the shell is cached so a warm launch needs no network.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
    <ReactRouterNavigationProvider>
      <GlassesRoot>
        <GlassesApp />
      </GlassesRoot>
    </ReactRouterNavigationProvider>
  </BrowserRouter>,
);
