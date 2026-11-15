import { useEffect, useRef, useState } from 'react';
import type { AppletDefinition } from '@junction26/applet-format';
import './glasses-demo.css';

const scenes = [
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'workshop', label: 'Workshop' },
  { id: 'laundry', label: 'Laundry' },
] as const;

export function GlassesDemo({ definition, resetKey, onClose }: { definition: AppletDefinition; resetKey: string; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const lens = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [ready, setReady] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [scene, setScene] = useState<string>('kitchen');
  const [outline, setOutline] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, location.origin);

  useEffect(() => {
    const el = lens.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setScale(el.clientWidth / 600));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin === location.origin && e.source === frame.current?.contentWindow && e.data?.type === 'j26.preview.ready') setReady(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  useEffect(() => {
    if (ready) {
      post({ type: 'j26.preview.load', definition, key: `${resetKey}:${nonce}` });
      frame.current?.focus();
    }
  }, [ready, definition, resetKey, nonce]);
  useEffect(() => {
    if (scene !== 'camera') return;
    let stopped = false;
    let stream: MediaStream | undefined;
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera is unavailable on this device or connection.');
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then((result) => {
      if (stopped) { result.getTracks().forEach((track) => track.stop()); return; }
      stream = result;
      if (video.current) video.current.srcObject = result;
    }).catch(() => { if (!stopped) setCameraError('Could not access your camera. Check permissions or choose a scene.'); });
    return () => { stopped = true; stream?.getTracks().forEach((track) => track.stop()); };
  }, [scene]);
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return;
      if (e.target instanceof HTMLElement && /^(BUTTON|SELECT|INPUT)$/.test(e.target.tagName)) return;
      e.preventDefault();
      frame.current?.focus();
    };
    window.addEventListener('keydown', handleKey);
    const child = frame.current?.contentWindow;
    // Escape inside the focused iframe should still close the overlay.
    const childKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    child?.addEventListener('keydown', childKey);
    return () => { window.removeEventListener('keydown', handleKey); child?.removeEventListener('keydown', childKey); };
  }, [onClose, ready]);
  return (
    <div className="demo" role="dialog" aria-modal="true" aria-label="See it on glasses">
      <div className="demo-scene" aria-hidden="true">
        {scene === 'camera' ? <video ref={video} autoPlay muted playsInline /> : <img src={`${import.meta.env.BASE_URL}demo-scenes/${scene}.webp`} alt="" />}
      </div>
      <header className="demo-header demo-chrome">
        <div><span className="demo-kicker">A different perspective</span><h2>See it on glasses</h2></div>
        <button className="demo-close" onClick={onClose} aria-label="Close glasses demo">×</button>
      </header>
      <main className="demo-stage">
        <div className="demo-lens" ref={lens}>
          <iframe ref={frame} title="Interactive glasses demo" src="./preview.html" width="600" height="600" onLoad={() => setReady(false)} style={{ transform: `scale(${scale})` }} />
          {outline && <svg className="demo-outline" viewBox="0 0 600 600" aria-hidden="true"><path d="M35 180 Q45 135 95 140 L505 140 Q555 135 565 180 L545 400 Q540 465 470 470 L130 470 Q60 465 55 400 Z" /></svg>}
        </div>
      </main>
      <div className="demo-bottom demo-chrome">
        <div className="demo-controls">
          <button onClick={() => post({ type: 'j26.preview.menu' })}>← Back</button>
          <button onClick={() => setNonce((n) => n + 1)}>↻ Start over</button>
          <label className="demo-outline-toggle"><input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} /> Frame outline</label>
        </div>
        <div className="demo-picker" aria-label="Choose a background scene">
          {scenes.map((item) => <button key={item.id} className={scene === item.id ? 'selected' : ''} aria-pressed={scene === item.id} onClick={() => setScene(item.id)}>{item.label}</button>)}
          <button className={scene === 'camera' ? 'selected' : ''} aria-pressed={scene === 'camera'} onClick={() => setScene('camera')}>Use my camera</button>
        </div>
        {cameraError && <p className="demo-error" role="alert">{cameraError}</p>}
        <p className="demo-note">Simulated view. Real glasses render this on a see-through display.</p>
      </div>
    </div>
  );
}
