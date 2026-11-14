import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  App, Page,
  Button, ButtonGroup, TextView, TextStyle, TextColor,
} from '@wearables-ui-toolkit/mrbd';
import { assertContent, checkCopy, checkIds, COPY_LIMITS } from './constraints.js';
import { inkify } from './ink.js';
export { inkify, type InkOptions } from './ink.js';
export { COPY_LIMITS, checkCopy, checkIds } from './constraints.js';
export type { ContentIssue } from './constraints.js';

export interface GlassesAction {
  /** Stable capability ID; use the same ID in the future voice action registry. */
  id: string;
  label: string;
  onActivate: () => void;
  disabled?: boolean;
}

/** Mount once, inside the host's navigation provider. Import styles.css once. */
export function GlassesRoot({ children }: { children: ReactNode }) {
  return <App>{children}</App>;
}

export function ActionBar({ actions }: { actions: readonly GlassesAction[] }) {
  assertContent([
    ...checkIds(actions),
    ...actions.flatMap(a => checkCopy(`actions.${a.id}.label`, a.label, COPY_LIMITS.label)),
    ...(actions.length > COPY_LIMITS.actions ? [{ path: 'actions', message: 'Use at most two primary actions; move other commands to a choice screen.' }] : []),
  ]);
  if (!actions.length) return null;
  return <div className="g-action-dock"><ButtonGroup>
    {actions.map(a => <Button key={a.id} title={a.label} alwaysShowText disabled={a.disabled} onClick={a.onActivate} />)}
  </ButtonGroup></div>;
}

/** Fixed pages only. Overflow is a content error, never a scroll affordance. */
export function ContentScreen({ title, children, actions = [], footer }: {
  title?: string; children: ReactNode; actions?: readonly GlassesAction[];
  /** Page-level component between the content and the dock (e.g. VoiceNoteBar). Takes space from the content. */
  footer?: ReactNode;
}) {
  if (title !== undefined) assertContent(checkCopy('title', title, COPY_LIMITS.title));
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [failedContent, setFailedContent] = useState<{ value: ReactNode } | null>(null);
  const overflow = failedContent?.value === children;
  useLayoutEffect(() => {
    const outer = viewport.current;
    const inner = content.current;
    if (!outer || !inner) return;
    const measure = () => {
      if (outer.clientHeight <= 0 || outer.clientWidth <= 0) return;
      const available = outer.getBoundingClientRect();
      // Material glows may extend beyond their host without hiding content.
      // Measure authored content bounds, rather than counting decorative paint as overflow.
      const nodes = [...inner.children, ...inner.querySelectorAll('[data-g-fit-content]')];
      if (nodes.some(node => {
        const r = node.getBoundingClientRect();
        return r.top < available.top - 1 || r.bottom > available.bottom + 1 ||
          r.left < available.left - 1 || r.right > available.right + 1;
      })) setFailedContent({ value: children });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    // Images and fonts can change fit after the first layout.
    inner.addEventListener('load', measure, true);
    void document.fonts.ready.then(measure);
    measure();
    return () => { observer.disconnect(); inner.removeEventListener('load', measure, true); };
  }, [children, title]);
  return <Page showHeader={false} enableSystemBarInset={false}>
    <div className="g-screen-shell">
      <div className={title ? "g-page-title" : "g-page-title-empty"}>{title && <TextView as="h1" className="g-title" textStyle={TextStyle.HEADING2}>{title}</TextView>}</div>
      <div className="g-viewport" ref={viewport}>
        {overflow ? <div className="g-fit-error" role="alert"><TextView as="p" textStyle={TextStyle.BODY2}>
          This page does not fit. Split it into smaller pages in the editor.
        </TextView></div> : <div className="g-content" ref={content}>{children}</div>}
      </div>
      {footer ?? <div />}
      <ActionBar actions={actions} />
    </div>
  </Page>;
}

/**
 * Static information region. The display is additive: it can only add light,
 * so a plate, blur or dimming layer cannot hide the world behind the lens and
 * only washes out our own content. Readability comes from bright, heavy ink.
 */
export function ReadableSurface({ children }: { children: ReactNode }) {
  return <div className="g-readable-surface">{children}</div>;
}

/** One source region, fitted in full. Detail belongs on another page, never in a pan/scroll area. */
export function Diagram({ src, alt, stroke }: { src: string; alt: string; /** Display stroke width in CSS px. */ stroke?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [inked, setInked] = useState<{ src: string; url: string } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let alive = true;
    let timer = 0;
    const run = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width < 8 || height < 8) return;
      inkify(src, width, height, window.devicePixelRatio || 1, { stroke })
        .then(url => { if (alive) setInked({ src, url }); })
        .catch(() => { /* Keep showing the source image. */ });
    };
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = window.setTimeout(run, 60); });
    observer.observe(el);
    run();
    return () => { alive = false; clearTimeout(timer); observer.disconnect(); };
  }, [src, stroke]);
  const ready = inked?.src === src;
  return <div className="g-diagram-box" ref={box}>
    <img data-g-fit-content data-src={src} className={ready ? 'g-diagram' : 'g-diagram g-diagram-pending'}
      src={ready ? inked.url : src} alt={alt} />
  </div>;
}

/** One short thought. Never silently truncate generated instructions. */
export function TextBlock({ label, text, hint }: { label?: string; text: string; hint?: string }) {
  assertContent([
    ...checkCopy('text', text, COPY_LIMITS.body),
    ...(label === undefined ? [] : checkCopy('label', label, COPY_LIMITS.label)),
    ...(hint === undefined ? [] : checkCopy('hint', hint, COPY_LIMITS.hint)),
  ]);
  return <section data-g-fit-content className="g-stack g-copy">
    {label && <TextView as="h2" className="g-eyebrow" textStyle={TextStyle.LABEL_EMPHASIZED} textColor={TextColor.ACCENT}>{label.toLocaleUpperCase()}</TextView>}
    <TextView as="p" className="g-body" textStyle={TextStyle.BODY1_EMPHASIZED}>{text}</TextView>
    {hint && <TextView as="p" className="g-hint" textStyle={TextStyle.BODY2}>{hint}</TextView>}
  </section>;
}

export function ValueReadout({ label, value, hint }: { label: string; value: string; hint?: string }) {
  assertContent([
    ...checkCopy('label', label, COPY_LIMITS.label),
    ...checkCopy('value', value, COPY_LIMITS.value),
    ...(hint === undefined ? [] : checkCopy('hint', hint, COPY_LIMITS.hint)),
  ]);
  return <section data-g-fit-content className="g-stack g-copy g-readout" aria-label={`${label}: ${value}`}>
    <TextView as="h2" className="g-eyebrow" textStyle={TextStyle.LABEL_EMPHASIZED} textColor={TextColor.ACCENT}>{label.toLocaleUpperCase()}</TextView>
    <TextView as="p" className="g-value" textStyle={TextStyle.NUMERAL2}>{value}</TextView>
    {hint && <TextView as="p" className="g-hint" textStyle={TextStyle.BODY2}>{hint}</TextView>}
  </section>;
}

/** Page-by-page instructions; progress and persistence belong to the caller. */
export function InstructionScreen({ title, step, total, text, hint, actions }: {
  title: string; step: number; total: number; text: string; hint?: string;
  actions?: readonly GlassesAction[];
}) {
  if (!Number.isSafeInteger(step) || !Number.isSafeInteger(total) || step < 1 || step > total) {
    throw new Error('Instruction progress requires integers with 1 <= step <= total.');
  }
  return <ContentScreen title={title} actions={actions}>
    <TextBlock label={`Step ${step} of ${total}`} text={text} hint={hint} />
  </ContentScreen>;
}
