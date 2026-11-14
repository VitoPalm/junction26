import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@wearables-ui-toolkit/mrbd';
import { ChoiceScreen, ContentScreen, TextBlock, paginateText, type GlassesAction } from '@junction26/glasses-ui';
import {
  answerLocally, cancelBranch, cancelRequest, coachOf, coachStep, completeCurrent, confirmBranch, currentStep, dismissAnswer,
  formatSource, partLabel, pendingRequest, repeatText, setPanel, setRequestError, showLocalAnswer, startRequest, stepIndex,
  type AppletState, type CoachRequestKind,
} from '@junction26/applet-runtime';
import type { AppletDefinition, SourceRef } from '@junction26/applet-format';
import type { AppletSession } from './session.ts';

/**
 * Task coach screen for a guide made from a manual (docs/task-coach.md).
 * One instruction at a time with its parts, caution and page reference;
 * Previous / Next (Complete on the last step) in the dock; everything else in
 * the More menu, so every voice tool has a band path. Pure transitions from
 * applet-runtime, persisted through `session.update` before they show.
 */

type Panel = null | 'menu' | 'ask' | 'report' | { type: CoachRequestKind };

const ASK_PRESETS = ['Which parts do I need?', 'Anything to be careful of?', 'How many steps are left?'];
const REPORT_PRESETS = ['I fitted a part backwards', 'A part is missing', 'It doesn’t fit'];

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

/** Starts an ask/report from the band, voice or preview. Shared with the voice tools. */
export async function askCoach(session: AppletSession, kind: CoachRequestKind, text: string, clarifications: string[] = []): Promise<AppletState> {
  const def = session.definition;
  return session.update((s) => {
    const cur = currentStep(def, s);
    if (!cur) return s;
    if (kind === 'question' && !clarifications.length) {
      const local = answerLocally(def, s, text);
      if (local) return showLocalAnswer(s, local);
    }
    // The same question while one is already pending: keep the pending one.
    const pending = pendingRequest(s, kind);
    if (pending && pending.text === text.trim() && pending.clarifications.join('|') === clarifications.join('|')) return s;
    return startRequest(s, { id: newId(), kind, text: text.trim(), stepId: cur.step.id, createdAt: new Date().toISOString(), clarifications });
  });
}

/** Says text aloud where the platform supports it (best effort; the screen shows it too). */
function speak(text: string) {
  try {
    const synth = globalThis.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return;
    synth.cancel();
    synth.speak(new SpeechSynthesisUtterance(text));
  } catch {
    /* optional */
  }
}

export function repeatStep(session: AppletSession): Promise<AppletState> {
  const def = session.definition;
  return session.update((s) => {
    const coach = coachOf(s);
    const b = coach.branch?.status === 'active' ? coach.branch : null;
    const cur = currentStep(def, s);
    if (!cur) return s;
    const text = b ? `Fix step ${b.index + 1}: ${b.steps[b.index]!.text}` : repeatText(cur);
    speak(text);
    return showLocalAnswer(s, { requestId: null, status: 'answered', text, sources: [b ? b.steps[b.index]!.source : cur.step.source].filter((x): x is SourceRef => !!x), local: true, options: [] });
  });
}

function sourceLine(sources: SourceRef[]): string {
  // A page-only reference adds nothing next to "p. 2, Step 2".
  const specific = sources.filter((x) => x.section || !sources.some((y) => y !== x && y.page === x.page && y.section));
  const s = specific.map(formatSource).filter(Boolean).slice(0, 2).join('; ');
  return s ? `Manual ${s}`.slice(0, 48) : '';
}

/** Long text over discrete pages (no scrolling), with its source on every page. */
function PagedCard({ title, label, text, hint, done, doneLabel = 'OK', extra }: {
  title?: string; label?: string; text: string; hint?: string; done: () => void; doneLabel?: string; extra?: GlassesAction;
}) {
  const pages = paginateText(text);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [text]);
  const last = page >= pages.length - 1;
  const actions: GlassesAction[] = [
    ...(extra ? [extra] : []),
    last ? { id: 'coach.card.done', label: doneLabel, onActivate: done } : { id: 'coach.card.more', label: 'More', onActivate: () => setPage(page + 1) },
  ];
  return (
    <ContentScreen title={title} actions={actions.slice(-2)}>
      <TextBlock label={pages.length > 1 ? `${label ?? ''} ${page + 1}/${pages.length}`.trim() : label} text={pages[Math.min(page, pages.length - 1)] ?? ''} hint={hint || undefined} />
    </ContentScreen>
  );
}

function stepLabel(def: AppletDefinition, s: AppletState) {
  const cur = currentStep(def, s)!;
  const src = formatSource(cur.step.source);
  return `Step ${cur.index + 1} of ${cur.total}${src ? ` · ${src}` : ''}`.slice(0, 28);
}

function MoreButton({ onActivate, status }: { onActivate: () => void; status?: string }) {
  return (
    <div data-g-fit-content className="g-coach-footer">
      {status ? <span className="g-coach-status" role="status">{status}</span> : null}
      <Button title="More" alwaysShowText onClick={onActivate} />
    </div>
  );
}

export function CoachScreen({ session, sequenceTitle, image }: { session: AppletSession; sequenceTitle?: string; /** Diagram for an image step, when its bytes are downloaded. */ image?: (assetId: string, alt: string) => ReactNode }) {
  const def = session.definition;
  const s = session.state;
  const coach = coachOf(s);
  const cur = currentStep(def, s);
  const [panel, setLocalPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState('');
  const update = (fn: (x: AppletState) => AppletState) => void session.update(fn);
  const back = () => setLocalPanel(null);
  if (!cur) return <ContentScreen><TextBlock text="This guide has no steps." /></ContentScreen>;

  const pending = pendingRequest(s);
  const branch = coach.branch;

  // ---- results and requests take over the screen until handled
  if (pending) {
    const waiting = pending.error === 'offline' ? 'No connection. It will retry.' : pending.error ? `Couldn’t check: ${pending.error}` : '';
    return (
      <ContentScreen title={pending.kind === 'question' ? 'Checking the manual' : 'Finding a fix'} actions={[
        ...(pending.error ? [{ id: 'coach.retry', label: 'Retry', onActivate: () => update((x) => setRequestError(x, pending.id, null)) }] : []),
        { id: 'coach.cancel', label: 'Cancel', onActivate: () => update((x) => cancelRequest(x, pending.id)) },
      ]}>
        <TextBlock label={pending.kind === 'question' ? 'Your question' : 'Your problem'} text={pending.text.slice(0, 120)} hint={waiting || 'Keep working. The answer shows here.'} />
      </ContentScreen>
    );
  }
  if (coach.clarify) {
    const c = coach.clarify;
    const req = coach.requests.find((r) => r.id === c.requestId);
    return (
      <ChoiceScreen key="cs1"         title={c.question.slice(0, 32)}
        items={[...c.options.map((o, i) => ({ id: `opt${i}`, label: o })), { id: 'cancel', label: 'Cancel' }]}
        onChoose={(id) => {
          if (id === 'cancel' || !req) return update((x) => dismissAnswer({ ...x, coach: { ...coachOf(x), clarify: null } }));
          const choice = c.options[Number(id.slice(3))]!;
          void askCoach(session, req.kind, req.text, [...req.clarifications, choice]);
        }}
      />
    );
  }
  if (branch?.status === 'proposed') {
    const ret = stepIndex(def, branch.returnStepId) + 1;
    return (
      <ContentScreen title={branch.title} actions={[
        { id: 'coach.fix.cancel', label: 'Cancel', onActivate: () => update((x) => cancelBranch(def, x)) },
        { id: 'coach.fix.confirm', label: 'Use this fix', onActivate: () => update((x) => confirmBranch(x, branch.id)) },
      ]}>
        <TextBlock label={`Proposed fix · ${branch.steps.length} steps`} text={(branch.rationale || 'Follow these steps, then continue the guide.').slice(0, 120)} hint={`Then back to step ${ret}. ${sourceLine(branch.sources)}`.slice(0, 48)} />
      </ContentScreen>
    );
  }
  if (coach.answer) {
    const a = coach.answer;
    return <PagedCard title={a.status === 'answered' ? 'From the manual' : a.status === 'failed' ? 'Couldn’t check' : 'Not in the manual'} label={a.status === 'failed' ? 'Try again later' : 'Answer'} text={a.text} hint={sourceLine(a.sources)} done={() => update(dismissAnswer)} />;
  }
  if (coach.panel === 'parts') {
    return (
      <ChoiceScreen key="cs2"         title={`Parts for step ${cur.index + 1}`}
        emptyText="The manual lists no parts for this step."
        items={[...cur.parts.map((p) => ({ id: `part_${p.id}`, label: p.label, hint: [p.quantity ? `×${p.quantity}` : '', p.detail ?? ''].filter(Boolean).join(' · ').slice(0, 48) || undefined })), { id: 'back', label: 'Back to step' }]}
        onChoose={(id) => id === 'back' && update((x) => setPanel(x, null))}
      />
    );
  }

  // ---- band-only menus
  if (panel === 'menu') {
    const last = cur.index === cur.total - 1;
    const items = [
      { id: 'repeat', label: 'Repeat' },
      { id: 'parts', label: 'Show parts' },
      { id: 'ask', label: 'Ask a question' },
      { id: 'report', label: 'Report a problem' },
      ...(branch?.status === 'active' ? [{ id: 'cancel_fix', label: 'Stop this fix' }] : [{ id: 'complete', label: last ? 'Complete guide' : 'Complete step' }]),
      { id: 'back', label: 'Back to step' },
    ];
    return (
      <ChoiceScreen key="cs3" title="Coach" items={items} onChoose={(id) => {
        setLocalPanel(id === 'ask' ? 'ask' : id === 'report' ? 'report' : null);
        if (id === 'repeat') void repeatStep(session);
        if (id === 'parts') update((x) => setPanel(x, 'parts'));
        if (id === 'complete') update((x) => completeCurrent(def, x));
        if (id === 'cancel_fix') update((x) => cancelBranch(def, x));
      }} />
    );
  }
  if (panel === 'ask' || panel === 'report') {
    const kind: CoachRequestKind = panel === 'ask' ? 'question' : 'problem';
    const presets = panel === 'ask' ? ASK_PRESETS : REPORT_PRESETS;
    return (
      <ChoiceScreen key="cs4" title={panel === 'ask' ? 'Ask about this step' : 'What went wrong?'}
        items={[...presets.map((p, i) => ({ id: `p${i}`, label: p })), { id: 'type', label: panel === 'ask' ? 'Type a question' : 'Describe it' }, { id: 'back', label: 'Back' }]}
        onChoose={(id) => {
          if (id === 'back') return setLocalPanel('menu');
          if (id === 'type') return setLocalPanel({ type: kind });
          back();
          void askCoach(session, kind, presets[Number(id.slice(1))]!);
        }} />
    );
  }
  if (panel && typeof panel === 'object') {
    // Focusing and selecting the field opens Meta's dictation/handwriting composer.
    return (
      <ContentScreen title={panel.type === 'question' ? 'Your question' : 'Your problem'} actions={[
        { id: 'coach.type.back', label: 'Back', onActivate: () => setLocalPanel(panel.type === 'question' ? 'ask' : 'report') },
        { id: 'coach.type.send', label: 'Send', disabled: !draft.trim(), onActivate: () => { const t = draft; setDraft(''); back(); void askCoach(session, panel.type, t); } },
      ]}>
        <TextBlock text="Select the box and say or write it." />
        <div data-g-fit-content className="j26-pair">
          <input className="j26-code" value={draft} maxLength={500} aria-label={panel.type === 'question' ? 'Question' : 'Problem'} autoComplete="off"
            onChange={(e) => setDraft(e.target.value)} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
        </div>
      </ContentScreen>
    );
  }

  // ---- the step itself
  const footer: ReactNode = <MoreButton onActivate={() => setLocalPanel('menu')} status={coach.finished ? 'Guide complete' : undefined} />;
  if (branch?.status === 'active') {
    const st = branch.steps[branch.index]!;
    const lastFix = branch.index === branch.steps.length - 1;
    return (
      <ContentScreen key={`fix-${branch.index}`} title={branch.title} footer={footer} actions={[
        { id: 'coach.previous', label: 'Previous', disabled: branch.index === 0, onActivate: () => update((x) => coachStep(def, x, -1)) },
        { id: 'coach.next', label: lastFix ? 'Back to guide' : 'Next', onActivate: () => update((x) => coachStep(def, x, 1)) },
      ]}>
        <TextBlock label={`Fix ${branch.index + 1} of ${branch.steps.length}`} text={st.text} hint={sourceLine(st.source ? [st.source] : []) || undefined} />
      </ContentScreen>
    );
  }
  const step = cur.step;
  const done = coach.completed.includes(step.id);
  const last = cur.index === cur.total - 1;
  // One line: what's unclear, then cautions, then the step's own tip, then the parts it uses.
  const hint = step.flag ? `Unclear in manual: ${step.flagNote ?? step.flag}` : step.warning ? `Caution: ${step.warning}` : step.hint ?? (cur.parts.length ? `Uses ${cur.parts.map((p) => p.label.replace(/^.*\(([A-Z0-9]+)\)$/, '$1')).join(', ')}` : undefined);
  return (
    <ContentScreen key={step.id} title={(step.title ?? sequenceTitle)?.slice(0, 32)} footer={footer} actions={[
      { id: 'coach.previous', label: 'Previous', disabled: cur.index === 0, onActivate: () => update((x) => coachStep(def, x, -1)) },
      last
        ? { id: 'coach.complete', label: coach.finished ? 'Done' : 'Complete', disabled: coach.finished, onActivate: () => update((x) => completeCurrent(def, x)) }
        : { id: 'coach.next', label: 'Next', onActivate: () => update((x) => coachStep(def, x, 1)) },
    ]}>
      {step.image && image ? image(step.image, step.alt ?? `Step ${cur.index + 1}`) : null}
      {step.text || !step.image || !image
        ? <TextBlock label={`${stepLabel(def, s)}${done ? ' ✓' : ''}`.slice(0, 28)} text={step.text ?? step.alt ?? 'See the diagram in the manual.'} hint={hint?.slice(0, 48)} />
        : null}
    </ContentScreen>
  );
}
