import { useEffect, useRef, useState } from 'react';
import { toolName, type AppletDefinition } from '@junction26/applet-format';

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
  const [lastVoice, setLastVoice] = useState<string | null>(null);

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
        setLastVoice(r.ok ? `✓ ${r.summary ?? r.next_action ?? 'Done'}` : `✗ ${r.message ?? 'Failed'}`);
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
      <div ref={box} className="glasses-box" style={{ height: 600 * scale }}>
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
      <div className="row">
        <button className="ghost" onClick={() => post({ type: 'j26.preview.menu' })}>Back</button>
        <button className="ghost" onClick={() => setNonce((n) => n + 1)}>Reset preview</button>
      </div>
      <VoiceTester definition={definition} onRun={(name, args) => post({ type: 'j26.preview.tool', name, args, id: Date.now() })} result={lastVoice} />
    </div>
  );
}

/** Try what "Hey Meta, …" would do: call the same WebMCP tools the glasses register. */
function VoiceTester({ definition, onRun, result }: { definition: AppletDefinition; onRun: (name: string, args: Record<string, string>) => void; result: string | null }) {
  const [actionId, setActionId] = useState('');
  const [args, setArgs] = useState<Record<string, string>>({});
  const action = definition.actions.find((a) => a.id === actionId);
  if (!definition.actions.length) return null;
  return (
    <details className="card voice">
      <summary>Try a voice command</summary>
      <div className="stack">
        <select value={actionId} onChange={(e) => { setActionId(e.target.value); setArgs({}); }} aria-label="Command">
          <option value="">Choose a command…</option>
          {definition.actions.map((a) => (
            <option key={a.id} value={a.id}>{a.examples?.[0] ? `“${a.examples[0]}”` : a.label}</option>
          ))}
        </select>
        {action?.args.map((a) => (
          <label key={a.name} className="field">
            <span>{a.description}</span>
            <input value={args[a.name] ?? ''} placeholder={a.default !== undefined ? String(a.default) : a.required ? 'required' : ''} onChange={(e) => setArgs({ ...args, [a.name]: e.target.value })} />
          </label>
        ))}
        {action && (
          <button className="secondary" onClick={() => onRun(toolName(definition.toolPrefix, action.id), Object.fromEntries(Object.entries(args).filter(([, v]) => v !== '')))}>
            Run
          </button>
        )}
        {result && <p className="tiny">{result}</p>}
      </div>
    </details>
  );
}
