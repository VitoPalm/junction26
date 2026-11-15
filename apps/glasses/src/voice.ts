import { useEffect, useState } from 'react';
import type { AppletDefinition } from '@junction26/applet-format';
import { appletTools, voiceContext, type ToolHost } from '@junction26/applet-renderer';
import { pairing } from './sync.ts';

/**
 * Voice bridge client (docs/voice-fallback.md). The always-listening phone
 * bridge sends speech to the API; the API pushes `command` events here and we
 * run them with the same executors as WebMCP. Opt-in (off by default): while
 * on and an applet is open, this is the one exception to "network only on
 * explicit actions". The stream closes whenever the app is hidden.
 */

const API = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';
const PREF = 'j26.voice';
const CONTEXT_CHECK_MS = 2000;
const CHIP_MS = 3500;

export function voiceEnabled(): boolean {
  try {
    return localStorage.getItem(PREF) === '1';
  } catch {
    return false;
  }
}

export function setVoiceEnabled(on: boolean) {
  try {
    if (on) localStorage.setItem(PREF, '1');
    else localStorage.removeItem(PREF);
  } catch {}
  emit({ kind: 'pref' });
}

// --------------------------------------------------------- chip (UI) state

export interface VoiceChip {
  heard: string;
  result: string;
  ok: boolean;
}
type Signal = { kind: 'pref' } | { kind: 'chip'; chip: VoiceChip | null };
const listeners = new Set<(s: Signal) => void>();
const emit = (s: Signal) => listeners.forEach((l) => l(s));
let chipTimer = 0;
/** A transient echo, not content: shortened to one line each so it can't overflow. */
const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
function showChip(chip: VoiceChip) {
  clearTimeout(chipTimer);
  emit({ kind: 'chip', chip: { ...chip, heard: short(chip.heard, 36), result: short(chip.result, 30) } });
  chipTimer = window.setTimeout(() => emit({ kind: 'chip', chip: null }), CHIP_MS);
}

export function useVoiceChip(): VoiceChip | null {
  const [chip, setChip] = useState<VoiceChip | null>(null);
  useEffect(() => {
    const l = (s: Signal) => s.kind === 'chip' && setChip(s.chip);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return chip;
}

export function useVoicePref(): boolean {
  const [on, setOn] = useState(voiceEnabled);
  useEffect(() => {
    const l = (s: Signal) => s.kind === 'pref' && setOn(voiceEnabled());
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return on;
}

// ------------------------------------------------------------- the bridge

function resultText(r: unknown): { text: string; ok: boolean } {
  const o = (r ?? {}) as { ok?: boolean; summary?: string; message?: string; values?: Record<string, unknown> };
  if (o.ok === false || 'error' in o) return { text: o.message ?? 'That didn’t work.', ok: false };
  if (o.summary) return { text: o.summary, ok: true };
  if (o.values) return { text: Object.entries(o.values).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '), ok: true };
  return { text: 'Done', ok: true };
}

/**
 * Runs while one applet is open and voice is on. Abort `signal` to stop;
 * the server forgets the context so the bridge stops resolving against it.
 */
export function startVoiceBridge(projectId: string, def: AppletDefinition, host: ToolHost, signal: AbortSignal) {
  if (!voiceEnabled()) return;
  let token: string | null = null;
  let stream: AbortController | null = null;
  let lastSent = '';
  let checkTimer = 0;
  let retryTimer = 0;
  let backoff = 1000;

  const headers = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  const contextBody = () => JSON.stringify(voiceContext(projectId, def, host));

  /** Cheap local check; network only when the applet's tools/values/view changed. */
  const syncContext = async () => {
    if (!token || signal.aborted || document.hidden) return;
    const body = contextBody();
    if (body === lastSent) return;
    lastSent = body;
    try {
      const r = await fetch(`${API}/v1/voice/context`, { method: 'PUT', headers: headers(), body, signal });
      if (!r.ok) lastSent = '';
    } catch {
      lastSent = '';
    }
  };

  const run = async (e: { id: string; tool: string; args: Record<string, unknown>; heard: string }) => {
    // Look the tool up in the applet as it is now; never trust a stale name.
    const tool = appletTools(def, host).find((t) => t.name === e.tool);
    if (!tool) return showChip({ heard: e.heard, result: 'Not available here', ok: false });
    let result: unknown;
    try {
      result = await tool.execute(e.args ?? {});
    } catch (err) {
      result = { ok: false, message: (err as Error).message };
    }
    const r = resultText(result);
    showChip({ heard: e.heard, result: r.text, ok: r.ok });
    void syncContext();
  };

  const connect = async () => {
    if (signal.aborted || document.hidden || stream) return;
    stream = new AbortController();
    const mine = stream;
    try {
      await syncContext();
      const res = await fetch(`${API}/v1/voice/events`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([signal, mine.signal]) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      backoff = 1000;
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
          if (event === 'command' && data) void run(JSON.parse(data));
        }
      }
    } catch {
      // Network blip, hidden, or aborted: fall through to reconnect logic.
    }
    if (stream === mine) stream = null;
    if (!signal.aborted && !document.hidden) {
      retryTimer = window.setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  };

  const onVisibility = () => {
    if (document.hidden) {
      // Platform rule: no sockets or timers while hidden.
      stream?.abort();
      stream = null;
      clearTimeout(retryTimer);
      clearInterval(checkTimer);
    } else {
      lastSent = '';
      checkTimer = window.setInterval(() => void syncContext(), CONTEXT_CHECK_MS);
      void connect();
    }
  };

  void (async () => {
    const p = await pairing();
    if (!p || signal.aborted) return;
    token = p.token;
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
  })();

  signal.addEventListener('abort', () => {
    document.removeEventListener('visibilitychange', onVisibility);
    stream?.abort();
    clearTimeout(retryTimer);
    clearInterval(checkTimer);
    if (token) void fetch(`${API}/v1/voice/context`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {});
  });
}
