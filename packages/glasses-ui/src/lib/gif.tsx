import { useEffect, useState } from 'react';
import { ContentScreen, TextBlock, type GlassesAction } from './content.js';

/** Packaged, intrinsically looping GIF. Never inkify/canvas: those flatten motion.
 * The host changes guide steps; this component has no playback controls.
 */
export function GifImage({ src, alt }: { src: string; alt: string }) {
  const [visible, setVisible] = useState(() => !document.hidden);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return <div className="g-diagram-box" data-g-gif data-g-gif-error={failedSource === src ? 'true' : undefined}
    role={failedSource === src ? 'alert' : undefined}>
    {failedSource === src
      ? <TextBlock text="This demonstration couldn't load. Sync the applet again from your phone." />
      : visible && <img key={src} data-g-fit-content className="g-diagram" src={src} alt={alt} onError={() => setFailedSource(src)} />}
  </div>;
}

/** Fixed GIF page with optional essential instruction (e.g. stitch counts).
 * Navigation actions belong to the guide, never to an autoplaying animation.
 */
export function GifScreen({ src, alt, title, instruction, hint, actions }: {
  src: string;
  alt: string;
  title?: string;
  instruction?: string;
  hint?: string;
  actions?: readonly GlassesAction[];
}) {
  return <ContentScreen title={title} actions={actions}>
    <GifImage src={src} alt={alt} />
    {(instruction || hint) && <TextBlock text={instruction ?? hint!} hint={instruction ? hint : undefined} />}
  </ContentScreen>;
}
