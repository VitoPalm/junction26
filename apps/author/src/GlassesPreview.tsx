import { useEffect, useRef, useState } from 'react';
import { toolName, type AppletDefinition } from '@junction26/applet-format';
import { ApiError, type Api, type VoiceContext } from './api.ts';
import { concat, downsample, encodeWav } from './audio.ts';
import { IconBack, IconCheck, IconMic, IconReset, IconWarn } from './icons.tsx';

/**
 * The applet exactly as the glasses render it: preview.html (same renderer,
 * runtime and validation) in a 600×600 iframe scaled to the available width.
 * Preview state is in-memory and separate from the wearer's real state.
 */
export function GlassesPreview({ definition, resetKey, projectId, api }: { definition: AppletDefinition; resetKey: string; projectId: string; api: Api }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);
  const [ready, setReady] = useState(false);
  const [nonce, setNonce] = useState(0);
  const pending = useRef(new Map<string, (value: any) => void>());
  const [lastVoice, setLastVoice] = useState<{ ok: boolean; text: string; at: number } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1, el.clientWidth / 600)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'j26.preview.ready') setReady(true);
      if (e.data?.type === 'j26.preview.context.result' || e.data?.type === 'j26.preview.tool.result') {
        pending.current.get(e.data.id)?.(e.data.context ?? e.data.result);
        pending.current.delete(e.data.id);
      }
      if (e.data?.type === 'j26.preview.tool.result') {
        const r = e.data.result as { ok?: boolean; summary?: string; message?: string; next_action?: string };
        setLastVoice({ ok: !!r.ok, text: r.ok ? (r.summary ?? r.next_action ?? 'Done') : (r.message ?? 'That didn’t work'), at: Date.now() });
      }
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);

  const post = (msg: unknown) => frame.current?.contentWindow?.postMessage(msg, location.origin);
  const request = (type: string, extra: object = {}) => new Promise<any>((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = window.setTimeout(() => { pending.current.delete(id); reject(new Error('Preview did not respond. Try again.')); }, 5000);
    pending.current.set(id, (value) => { clearTimeout(timer); resolve(value); });
    post({ type, id, ...extra });
  });
  useEffect(() => {
    if (ready) post({ type: 'j26.preview.load', definition, key: `${resetKey}:${nonce}` });
  }, [ready, definition, resetKey, nonce]);

  return (
    <div className="glasses">
      <div className="lens">
        <div ref={box} className="lens-screen" style={{ height: 600 * scale }}>
          <iframe
            ref={frame}
            title="Glasses preview"
            src="./preview.html"
            width={600}
            height={600}
            style={{ transform: `scale(${scale})` }}
            onLoad={() => setReady(false)}
          />
        </div>
      </div>
      <div className="lens-controls">
        <button className="pill-btn" onClick={() => post({ type: 'j26.preview.menu' })}><IconBack size={16} /> Back</button>
        <button className="pill-btn" onClick={() => { setNonce((n) => n + 1); setLastVoice(null); }}><IconReset size={16} /> Start over</button>
        <span className="grow" />
        <span className="lens-hint">Tap to try it. Practice taps don’t change your glasses.</span>
      </div>
      <BrowserVoice api={api} projectId={projectId} ready={ready} request={request} />
      <VoiceTester
        definition={definition}
        onRun={(name, args) => post({ type: 'j26.preview.tool', name, args, id: Date.now() })}
        result={lastVoice}
      />
    </div>
  );
}

/** Browser microphone, independent of Meta AI and the paired glasses. */
function BrowserVoice({ api, projectId, ready, request }: { api: Api; projectId: string; ready: boolean; request: (type: string, extra?: object) => Promise<any> }) {
  const [phase, setPhase] = useState<'idle' | 'arming' | 'listening' | 'thinking'>('idle');
  const [level, setLevel] = useState(0);
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef(false);
  const capture = useRef<{ stream: MediaStream; ctx: AudioContext; node: ScriptProcessorNode; chunks: Float32Array[]; timer: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current = false; const c = capture.current; if (c) { capture.current = null; clearTimeout(c.timer); c.node.disconnect(); c.stream.getTracks().forEach((t) => t.stop()); void c.ctx.close(); } }; }, []);

  const send = async (utterance: { text: string } | { audio: { format: 'wav'; data: string } }) => {
    setPhase('thinking'); setMessage('');
    try {
      const context = await request('j26.preview.context') as VoiceContext;
      context.projectId = projectId;
      const result = await api.resolveVoice({ context, ...utterance });
      let outcome = result.outcome === 'ignored' ? `Ignored: ${result.reason}` : '';
      if (result.outcome === 'command') {
        const value = await request('j26.preview.tool', { name: result.tool, args: result.args });
        outcome = value.summary ?? value.message ?? (value.values ? Object.entries(value.values).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : value.next_action ?? 'Done');
      }
      if (mounted.current) setMessage(`Heard: ${result.heard} — ${outcome}`);
    } catch (e) {
      if (mounted.current) setMessage(e instanceof ApiError && e.status === 402 && e.code === 'budget_exhausted' ? 'Your demo budget is used up' : e instanceof ApiError && e.status === 503 ? 'Voice is unavailable. Try again.' : (e as Error).message || 'Something went wrong. Try again.');
    } finally { if (mounted.current) setPhase('idle'); }
  };
  const stop = () => {
    active.current = false;
    const c = capture.current;
    if (!c) return;
    capture.current = null; clearTimeout(c.timer); c.node.disconnect(); c.stream.getTracks().forEach((t) => t.stop()); void c.ctx.close(); setLevel(0);
    const wav = encodeWav(downsample(concat(c.chunks), c.ctx.sampleRate));
    let binary = ''; for (let i = 0; i < wav.length; i += 0x8000) binary += String.fromCharCode(...wav.subarray(i, i + 0x8000));
    void send({ audio: { format: 'wav', data: btoa(binary) } });
  };
  const start = async () => {
    if (active.current || phase !== 'idle' || !ready) return;
    active.current = true; setPhase('arming'); setMessage('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (!active.current || !mounted.current) { stream.getTracks().forEach((t) => t.stop()); if (mounted.current) setPhase('idle'); return; }
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream); const node = ctx.createScriptProcessor(2048, 1, 1); const mute = ctx.createGain(); mute.gain.value = 0;
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => { const samples = e.inputBuffer.getChannelData(0).slice(); chunks.push(samples); let sum = 0; for (const x of samples) sum += x * x; setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 5)); };
      source.connect(node); node.connect(mute); mute.connect(ctx.destination);
      capture.current = { stream, ctx, node, chunks, timer: window.setTimeout(stop, 8000) };
      setPhase('listening');
    } catch (e) { active.current = false; if (mounted.current) { setPhase('idle'); setMessage((e as Error).name === 'NotAllowedError' ? 'Microphone permission denied. Allow access and try again.' : 'Microphone unavailable. Check your browser settings.'); } }
  };
  return <section className="voice browser-voice">
    <div><b>Browser voice</b><div className="tiny muted">Hold to speak to this preview in your browser.</div></div>
    <button className="voice-talk" disabled={!ready || phase === 'thinking'} onPointerDown={(e) => { if (e.button === 0) { e.currentTarget.setPointerCapture(e.pointerId); void start(); } }} onPointerUp={stop} onPointerCancel={stop} onKeyDown={(e) => { if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) void start(); } }} onKeyUp={(e) => { if (e.code === 'Space') { e.preventDefault(); stop(); } }} onBlur={() => { if (active.current) stop(); }}><IconMic size={20} /> {phase === 'arming' ? 'Starting microphone…' : phase === 'listening' ? 'Listening… release to send' : phase === 'thinking' ? 'Thinking…' : 'Hold to talk'}</button>
    {phase === 'listening' && <meter min={0} max={1} value={level} aria-label="Microphone level" />}
    <form className="voice-text" onSubmit={(e) => { e.preventDefault(); if (text.trim() && phase === 'idle') { void send({ text: text.trim() }); } }}><label htmlFor="voice-text">or type a command</label><div><input id="voice-text" value={text} onChange={(e) => setText(e.target.value)} /><button className="secondary" disabled={!ready || phase !== 'idle' || !text.trim()}>Send</button></div></form>
    {message && <p role="status" className="voice-result">{message}</p>}
  </section>;
}

/** Try what "Hey Meta, …" would do: call the same WebMCP tools the glasses register. */
function VoiceTester({ definition, onRun, result }: { definition: AppletDefinition; onRun: (name: string, args: Record<string, string>) => void; result: { ok: boolean; text: string; at: number } | null }) {
  const [actionId, setActionId] = useState('');
  const [args, setArgs] = useState<Record<string, string>>({});
  const action = definition.actions.find((a) => a.id === actionId);
  if (!definition.actions.length) return null;
  const run = (id: string, values: Record<string, string>) =>
    onRun(toolName(definition.toolPrefix, id), Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')));
  return (
    <section className="voice">
      <div className="voice-head">
        <span className="voice-icon"><IconMic size={18} /></span>
        <div>
          <b>Try saying</b>
          <span className="tiny muted">“Hey Meta, …” on the glasses</span>
        </div>
      </div>
      <div className="voice-chips">
        {definition.actions.map((a) => (
          <button
            key={a.id}
            className={a.id === actionId ? 'say on' : 'say'}
            aria-pressed={a.id === actionId}
            onClick={() => {
              setActionId(a.id);
              setArgs({});
              if (a.args.length === 0) run(a.id, {});
            }}
          >
            {a.examples?.[0] ? `“${a.examples[0]}”` : a.label}
          </button>
        ))}
      </div>
      {action && action.args.length > 0 && (
        <form
          className="voice-args"
          onSubmit={(e) => {
            e.preventDefault();
            run(action.id, args);
          }}
        >
          {action.args.map((a) => (
            <label key={a.name} className="field">
              <span>{a.description}</span>
              <input value={args[a.name] ?? ''} placeholder={a.default !== undefined ? String(a.default) : a.required ? 'Required' : 'Optional'} onChange={(e) => setArgs({ ...args, [a.name]: e.target.value })} />
            </label>
          ))}
          <button className="secondary">Say it</button>
        </form>
      )}
      {result && (
        <p key={result.at} className={result.ok ? 'voice-result ok' : 'voice-result bad'} role="status">
          {result.ok ? <IconCheck size={16} /> : <IconWarn size={16} />} {result.text}
        </p>
      )}
    </section>
  );
}
