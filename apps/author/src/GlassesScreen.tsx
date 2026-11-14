import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Device } from './api.ts';
import { useApp } from './App.tsx';
import { IconBack, IconCheck, IconGlasses, IconLink, IconReset, IconTrash } from './icons.tsx';
import { relativeTime } from './ui.ts';

/** Install the glasses app and pair it with this account. */
export function GlassesScreen() {
  const { api, session } = useApp();
  const [code, setCode] = useState<{ code: string; expiresAt: string; pairUrl: string } | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [baseline, setBaseline] = useState(0);
  const [justPaired, setJustPaired] = useState(false);
  const load = () => api.devices().then((r) => setDevices(r.devices), (e: Error) => setError(e.message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const remaining = useCountdown(code?.expiresAt);
  const expired = code !== null && remaining <= 0;

  // While a code is showing, notice when the glasses finish pairing.
  useEffect(() => {
    if (!code || expired) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [code, expired]); // eslint-disable-line react-hooks/exhaustive-deps

  // The glasses app lives on the API origin under /glasses/.
  const origin = session.server || location.origin;
  const glassesUrl = `${origin}/glasses/`;
  const installLink = `fb-viewapp://web_app_deep_link?appName=${encodeURIComponent('Solutions')}&appUrl=${encodeURIComponent(glassesUrl)}`;

  const newCode = async () => {
    setError(null);
    setBusy(true);
    try {
      setBaseline(devices?.filter((d) => !d.revokedAt).length ?? 0);
      setJustPaired(false);
      setCode(await api.pairingCode());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(glassesUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable; the URL is visible */
    }
  };

  const active = devices?.filter((d) => !d.revokedAt) ?? [];
  const removed = devices?.filter((d) => d.revokedAt) ?? [];
  useEffect(() => {
    if (code && active.length > baseline) {
      setCode(null);
      setJustPaired(true);
    }
  }, [code, active.length, baseline]);
  return (
    <main className="page narrow">
      <header className="topbar">
        <Link to="/" className="icon-btn" aria-label="Back"><IconBack size={22} /></Link>
        <span className="grow" />
      </header>

      <section className="glasses-hero">
        <div className={active.length ? 'glasses-badge on' : 'glasses-badge'}>
          <IconGlasses size={44} />
        </div>
        <h1 className="display">{active.length ? 'Your glasses are connected' : 'Connect your glasses'}</h1>
        <p className="lede">
          {active.length
            ? 'Send a solution from its preview, then choose Sync on your glasses.'
            : 'Add Solutions to your Meta Ray-Ban Display, then pair it with this account. You only do this once.'}
        </p>
      </section>

      <ol className="steps">
        <li className="step">
          <span className="step-num">1</span>
          <div className="step-body">
            <h2>Add the app to your glasses</h2>
            <p className="muted">First turn on Developer Mode in the Meta AI app: Settings → App info → tap the version 5 times.</p>
            <a className="secondary lg" href={installLink}>Open in Meta AI app</a>
            <details className="manual">
              <summary>Add it by hand instead</summary>
              <p className="muted">Meta AI app → Devices → Display glasses → App connections → Web apps, then add this address:</p>
              <button className="url-copy" onClick={() => void copyUrl()}>
                <code>{glassesUrl}</code>
                <span className="url-copy-act">{copied ? <><IconCheck size={15} /> Copied</> : <><IconLink size={15} /> Copy</>}</span>
              </button>
            </details>
          </div>
        </li>
        <li className="step">
          <span className="step-num">2</span>
          <div className="step-body">
            <h2>Pair</h2>
            {justPaired && !code ? (
              <p className="paired-ok"><IconCheck size={18} /> Paired. Your glasses can sync now.</p>
            ) : code && !expired ? (
              <>
                <p className="muted">On the glasses, open Solutions → Pair phone and enter:</p>
                <div className="code-boxes" aria-label={`Pairing code ${code.code}`}>
                  {[...code.code].map((ch, i) => (ch === '-' || ch === ' ' ? <span key={i} className="code-gap" /> : <span key={i} className="code-box">{ch}</span>))}
                </div>
                <div className="code-meta">
                  <span className="countdown" style={{ ['--p' as string]: Math.max(0, Math.min(1, remaining / 600)) }}>
                    Works once · expires in {formatClock(remaining)}
                  </span>
                </div>
              </>
            ) : (
              <>
                <p className="muted">{expired ? 'That code expired. Get a fresh one, it works for 10 minutes.' : 'Get a one-time code and type it on your glasses.'}</p>
                <button className="primary lg" disabled={busy} onClick={() => void newCode()}>
                  {expired ? <><IconReset size={18} /> New code</> : 'Get a pairing code'}
                </button>
              </>
            )}
          </div>
        </li>
      </ol>
      {error && <p className="error">{error}</p>}

      {devices && devices.length > 0 && (
        <section className="devices">
          <div className="section-head"><h2>Paired glasses</h2></div>
          <ul className="device-list">
            {active.map((d) => (
              <li key={d.id} className="device">
                <span className="device-icon"><IconGlasses size={22} /></span>
                <span className="grow">
                  <b>{d.label}</b>
                  <span className="tiny muted">{d.lastSeenAt ? `Last synced ${relativeTime(d.lastSeenAt)}` : `Paired ${relativeTime(d.createdAt)}`}</span>
                </span>
                <button
                  className="icon-btn danger"
                  aria-label={`Remove ${d.label}`}
                  onClick={() => {
                    if (confirm(`Remove “${d.label}”? It stops syncing until you pair it again.`)) void api.revokeDevice(d.id).then(load);
                  }}
                >
                  <IconTrash size={19} />
                </button>
              </li>
            ))}
            {removed.map((d) => (
              <li key={d.id} className="device removed">
                <span className="device-icon"><IconGlasses size={22} /></span>
                <span className="grow">
                  <b>{d.label}</b>
                  <span className="tiny muted">Removed</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function useCountdown(until: string | undefined): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.round((Date.parse(until) - now) / 1000)) : 0;
}

function formatClock(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
