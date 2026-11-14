import type { ReactNode } from 'react';
import {
  App, Page, ScrollView,
  Button, ButtonRail, TextView, TextStyle, TextColor,
} from '@wearables-ui-toolkit/mrbd';
import { assertContent, checkCopy, checkIds, COPY_LIMITS } from './constraints.js';
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
  return <div className="g-action-dock"><ButtonRail>
    {actions.map(a => <Button key={a.id} title={a.label} alwaysShowText disabled={a.disabled} onClick={a.onActivate} />)}
  </ButtonRail></div>;
}

/** Static content owns one scroll region; actions remain outside it. */
export function ContentScreen({ title, children, actions = [] }: {
  title: string; children: ReactNode; actions?: readonly GlassesAction[];
}) {
  assertContent(checkCopy('title', title, COPY_LIMITS.title));
  return <Page headerText={title} enableSystemBarInset={false}>
    <div className="g-screen-shell">
      <ScrollView insetForHeader ariaLabel={`${title} content`} tabIndex={0}>
        <div className="g-content">{children}</div>
      </ScrollView>
      <ActionBar actions={actions} />
    </div>
  </Page>;
}

/** One short thought. Never silently truncate generated instructions. */
export function TextBlock({ label, text, hint }: { label?: string; text: string; hint?: string }) {
  assertContent([
    ...checkCopy('text', text, COPY_LIMITS.body),
    ...(label === undefined ? [] : checkCopy('label', label, COPY_LIMITS.label)),
    ...(hint === undefined ? [] : checkCopy('hint', hint, COPY_LIMITS.hint)),
  ]);
  return <section className="g-stack">
    {label && <TextView as="h2" textStyle={TextStyle.BODY2_EMPHASIZED} textColor={TextColor.SECONDARY}>{label.toLocaleUpperCase()}</TextView>}
    <TextView as="p" textStyle={TextStyle.BODY2}>{text}</TextView>
    {hint && <TextView as="p" textStyle={TextStyle.BODY2} textColor={TextColor.SECONDARY}>{hint}</TextView>}
  </section>;
}

export function ValueReadout({ label, value, hint }: { label: string; value: string; hint?: string }) {
  assertContent([
    ...checkCopy('label', label, COPY_LIMITS.label),
    ...checkCopy('value', value, COPY_LIMITS.value),
    ...(hint === undefined ? [] : checkCopy('hint', hint, COPY_LIMITS.hint)),
  ]);
  return <section className="g-stack" aria-label={`${label}: ${value}`}>
    <TextView as="h2" textStyle={TextStyle.BODY2_EMPHASIZED} textColor={TextColor.SECONDARY}>{label.toLocaleUpperCase()}</TextView>
    <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED}>{value}</TextView>
    {hint && <TextView as="p" textStyle={TextStyle.BODY2} textColor={TextColor.SECONDARY}>{hint}</TextView>}
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
