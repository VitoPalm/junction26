import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Device } from './api.ts';
import { useApp } from './App.tsx';

/** Install the glasses app and pair it with this account. */
export function GlassesScreen() {
  const { api, session } = useApp();
  const [code, setCode] = useState<{ code: string; expiresAt: string; pairUrl: string } | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.devices().then((r) => setDevices(r.devices), (e: Error) => setError(e.message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The glasses app lives on the API origin under /glasses/.
  const origin = session.server || location.origin;
  const glassesUrl = `${origin}/glasses/`;
  const installLink = `fb-viewapp://web_app_deep_link?appName=${encodeURIComponent('Applets')}&appUrl=${encodeURIComponent(glassesUrl)}`;

  const newCode = async () => {
    setError(null);
    try {
      setCode(await api.pairingCode());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/" className="ghost" aria-label="Back">‹</Link>
        <h1 className="grow">Glasses</h1>
      </header>
      <section className="card stack">
        <h2>1. Add the app to your glasses</h2>
        <p className="muted">Needs Developer Mode in the Meta AI app (Settings → App info → tap the version 5 times).</p>
        <a className="secondary" href={installLink}>Open in Meta AI app</a>
        <p className="tiny muted">Or add it manually: Meta AI app → Devices → Display glasses → App connections → Web apps, URL <code>{glassesUrl}</code></p>
      </section>
      <section className="card stack">
        <h2>2. Pair</h2>
        {code ? (
          <>
            <p className="code">{code.code}</p>
            <p className="muted">On the glasses open Applets → Pair phone and enter this code. It works once, for 10 minutes.</p>
          </>
        ) : (
          <button className="primary" onClick={() => void newCode()}>Get a pairing code</button>
        )}
      </section>
      {error && <p className="error">{error}</p>}
      {devices.length > 0 && (
        <section className="card stack">
          <h2>Paired glasses</h2>
          <ul className="list">
            {devices.map((d) => (
              <li key={d.id} className="row">
                <span className="grow">{d.label}{d.revokedAt ? ' (removed)' : ''}</span>
                {!d.revokedAt && <button className="ghost" onClick={() => void api.revokeDevice(d.id).then(load)}>Remove</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
