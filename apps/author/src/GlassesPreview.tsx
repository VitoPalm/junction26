import { useEffect, useRef, useState } from 'react';
import { toolName, type AppletDefinition } from '@junction26/applet-format';
import { IconBack, IconCheck, IconMic, IconReset, IconWarn } from './icons.tsx';

/**
 * The applet exactly as the glasses render it: preview.html (same renderer,
 * runtime and validation) in a 600×600 iframe scaled to the available width.
 * Preview state is in-memory and separate from the wearer's real state.
 */
export function GlassesPreview({ definition, resetKey }: { definition: AppletDefinition; resetKey: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);
  const [ready, setReady] = useState(false);
  const [nonce, setNonce] = useState(0);
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
      if (e.data?.type === 'j26.preview.tool.result') {
        const r = e.data.result as { ok?: boolean; summary?: string; message?: string; next_action?: string };
        setLastVoice({ ok: !!r.ok, text: r.ok ? (r.summary ?? r.next_action ?? 'Done') : (r.message ?? 'That didn’t work'), at: Date.now() });
      }
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);

  const post = (msg: unknown) => frame.current?.contentWindow?.postMessage(msg, location.origin);
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
      <VoiceTester
        definition={definition}
        onRun={(name, args) => post({ type: 'j26.preview.tool', name, args, id: Date.now() })}
        result={lastVoice}
      />
    </div>
  );
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
