import { useEffect, useMemo, useState } from 'react';
import { Button } from '@wearables-ui-toolkit/mrbd';
import { COPY_LIMITS, ChoiceScreen, ContentScreen, TextBlock, paginateText, type GlassesAction } from '@junction26/glasses-ui';
import type { AppletSession, TaskModule, ToolDef } from '@junction26/applet-renderer';
import type { AppletDefinition } from '@junction26/applet-format';
import type { AppletState } from '@junction26/applet-runtime';
import { parseLaundry, type LaundryData } from './care.ts';
import { cardPages, type Explanation } from './explain.ts';
import {
  accept, answer, confirmStep, decline, dismiss, findGarment, laundryOf, move, report, showCard, showLabel, together, undo, view, whyGroup, whySeparate,
  type LaundryState, type ReportKind,
} from './state.ts';
import { explainSymbol } from './symbols.ts';
import './ui.css';

/**
 * Laundry task module for the glasses (docs/laundry.md). One concise action
 * per screen; Previous / Confirm in the dock; More for Show label, Explain
 * grouping, Ask, Report a change and Undo. Explanations and symbol meanings
 * are local (no AI request). Every voice tool mirrors a menu path. State lives
 * in `AppletState.task.laundry` and changes only through `session.update`
 * (saved before acknowledged).
 */

const SYMBOLS: [string, string][] = [
  ['Number in the tub', 'number in the washtub temperature'],
  ['Bars under the tub', 'one bar two bars under the tub'],
  ['Hand in the tub', 'hand wash'],
  ['Triangle', 'triangle bleach'],
  ['Square with circle', 'tumble dots'],
  ['Square with lines', 'line dry flat'],
  ['Iron', 'iron'],
  ['Circle', 'circle dry clean professional'],
];

function dataOf(def: AppletDefinition): LaundryData | null {
  const r = def.task?.kind === 'laundry' ? parseLaundry(def.task.data) : null;
  return r?.ok ? r.data : null;
}

function withLaundry(s: AppletState, l: LaundryState): AppletState {
  return { ...s, task: { ...(s.task ?? {}), laundry: l } };
}

export function updateLaundry(session: AppletSession, fn: (data: LaundryData, l: LaundryState) => LaundryState): Promise<LaundryState> {
  return session.update((s) => {
    const data = dataOf(session.definition);
    if (!data) return s;
    const cur = laundryOf(s.task);
    const next = fn(data, cur);
    return next === cur ? s : withLaundry(s, next);
  }).then((s) => laundryOf(s.task));
}

const opId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

function Card({ card, onDone }: { card: Explanation; onDone: () => void }) {
  const pages = useMemo(() => cardPages(card.lines, COPY_LIMITS.body), [card]);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [card]);
  const last = page >= pages.length - 1;
  return (
    <ContentScreen title={card.title.slice(0, 32)} actions={[last ? { id: 'laundry.card.ok', label: 'OK', onActivate: onDone } : { id: 'laundry.card.more', label: 'More', onActivate: () => setPage(page + 1) }]}>
      <TextBlock label={pages.length > 1 ? `${page + 1} of ${pages.length}` : undefined} text={pages[Math.min(page, pages.length - 1)] ?? ''} />
    </ContentScreen>
  );
}

type Panel = null | 'menu' | 'ask' | 'report' | 'symbols' | { pick: 'label' | 'why' | 'together_a' | 'new' | 'in_machine'; a?: string } | { pick: 'together_b'; a: string };

function Thumbs({ def, ids, data }: { def: AppletDefinition; ids: string[]; data: LaundryData }) {
  const items = ids.map((id) => data.garments.find((g) => g.id === id)).filter(Boolean).slice(0, 4);
  const imgs = items.map((g) => ({ g: g!, a: g!.thumbnail ? def.assets.find((a) => a.id === g!.thumbnail && a.data) : undefined })).filter((x) => x.a);
  if (!imgs.length) return null;
  return (
    <div data-g-fit-content className="l-thumbs">
      {imgs.map(({ g, a }) => <img key={g.id} src={`data:${a!.mediaType};base64,${a!.data}`} alt={g.name} width={72} height={72} />)}
    </div>
  );
}

export function LaundryScreen({ session }: { session: AppletSession }) {
  const def = session.definition;
  const data = useMemo(() => dataOf(def), [def]);
  const [panel, setPanel] = useState<Panel>(null);
  if (!data) return <ContentScreen title={def.title}><TextBlock text="This laundry plan can’t be read. Make it again on your phone." /></ContentScreen>;
  const l = laundryOf(session.state.task);
  const v = view(data, l);
  const up = (fn: (d: LaundryData, s: LaundryState) => LaundryState) => void updateLaundry(session, fn);
  const back = () => setPanel(null);
  const garmentItems = (ids: string[]) => ids.map((id) => ({ id, label: data.garments.find((g) => g.id === id)!.name }));
  const all = data.garments.map((g) => g.id);

  // ---- changes waiting for the wearer come first
  if (l.proposal) {
    return (
      <ContentScreen title={l.proposal.title.slice(0, 32)} actions={[
        { id: 'laundry.decline', label: 'Keep plan', onActivate: () => up((_, s) => decline(s)) },
        { id: 'laundry.accept', label: 'Change plan', onActivate: () => up((d, s) => accept(d, s, l.proposal!.id)) },
      ]}>
        <TextBlock label="Proposed change" text={paginateText(l.proposal.lines.join(' '))[0] ?? ''} hint="Nothing moves until you choose." />
      </ContentScreen>
    );
  }
  if (l.clarify) {
    return <ChoiceScreen key="cs1" title={l.clarify.question.slice(0, 32)} items={[...l.clarify.options.map((o) => ({ id: o, label: o.slice(0, 28) })), { id: '__cancel', label: 'Cancel' }]}
      onChoose={(id) => up((d, s) => (id === '__cancel' ? dismiss(s) : answer(d, s, id)))} />;
  }
  if (l.card) return <Card card={l.card} onDone={() => up((_, s) => dismiss(s))} />;

  // ---- band-only menus and pickers
  if (panel === 'menu') {
    return <ChoiceScreen key="cs2" title="Laundry" items={[
      { id: 'label', label: 'Show label' }, { id: 'explain', label: 'Explain grouping' }, { id: 'ask', label: 'Ask a question' },
      { id: 'report', label: 'Report a change' }, { id: 'undo', label: 'Undo', disabled: !l.undo.length }, { id: 'back', label: 'Back to step' },
    ]} onChoose={(id) => {
      if (id === 'label') return setPanel(v.step.garmentIds.length === 1 ? (up((d, s) => showLabel(d, s, v.step.garmentIds[0]!)), null) : { pick: 'label' });
      if (id === 'explain') { back(); return up((d, s) => whyGroup(d, s)); }
      if (id === 'undo') { back(); return up((_, s) => undo(s)); }
      setPanel(id === 'ask' ? 'ask' : id === 'report' ? 'report' : null);
    }} />;
  }
  if (panel === 'ask') {
    return <ChoiceScreen key="cs3" title="Ask a question" items={[{ id: 'why', label: 'Why is this separate?' }, { id: 'together', label: 'Can these go together?' }, { id: 'symbol', label: 'What does a symbol mean?' }, { id: 'back', label: 'Back' }]}
      onChoose={(id) => setPanel(id === 'why' ? { pick: 'why' } : id === 'together' ? { pick: 'together_a' } : id === 'symbol' ? 'symbols' : 'menu')} />;
  }
  if (panel === 'report') {
    return <ChoiceScreen key="cs4" title="What changed?" items={[{ id: 'new', label: 'This garment is new' }, { id: 'in', label: 'Already in the machine' }, { id: 'cycle', label: 'Washer lacks this cycle', disabled: !v.plan.washGroups.some((w) => w.id === v.step.groupId) }, { id: 'back', label: 'Back' }]}
      onChoose={(id) => {
        if (id === 'back') return setPanel('menu');
        if (id === 'cycle') { back(); return up((d, s) => report(d, s, 'no_cycle', { groupId: v.step.groupId, id: opId() })); }
        setPanel({ pick: id === 'new' ? 'new' : 'in_machine' });
      }} />;
  }
  if (panel === 'symbols') {
    return <ChoiceScreen key="cs5" title="Which symbol?" items={[...SYMBOLS.map(([label], i) => ({ id: `s${i}`, label })), { id: 'back', label: 'Back' }]}
      onChoose={(id) => {
        if (id === 'back') return setPanel('ask');
        back();
        const [label, q] = SYMBOLS[Number(id.slice(1))]!;
        up((_, s) => showCard(s, { title: label, lines: [explainSymbol(q) ?? 'I don’t have that symbol.', 'General meaning (ISO 3758 / US FTC); your garment’s own label comes first.'] }));
      }} />;
  }
  if (panel && typeof panel === 'object') {
    const p = panel;
    const ids = p.pick === 'label' || p.pick === 'in_machine' ? (v.step.garmentIds.length ? v.step.garmentIds : all) : all.filter((id) => id !== p.a);
    const title = { label: 'Whose label?', why: 'Which garment?', together_a: 'First garment', together_b: 'Together with…', new: 'Which is new?', in_machine: 'Which went in?' }[p.pick];
    return <ChoiceScreen key={`pick-${p.pick}`} title={title} items={[...garmentItems(ids), { id: '__back', label: 'Back' }]} onChoose={(id) => {
      if (id === '__back') return back();
      if (p.pick === 'together_a') return setPanel({ pick: 'together_b', a: id });
      back();
      if (p.pick === 'label') up((d, s) => showLabel(d, s, id));
      else if (p.pick === 'why') up((d, s) => whySeparate(d, s, id));
      else if (p.pick === 'together_b') up((d, s) => together(d, s, p.a!, id));
      else up((d, s) => report(d, s, p.pick === 'new' ? 'new' : 'in_machine', { garmentId: id, groupId: v.step.groupId, id: opId() }));
    }} />;
  }

  // ---- the step
  const done = l.confirmed.includes(v.step.id);
  const actions: GlassesAction[] = [
    { id: 'laundry.previous', label: 'Previous', disabled: v.index === 0, onActivate: () => up((d, s) => move(d, s, -1)) },
    done
      ? { id: 'laundry.next', label: 'Next', disabled: v.index === v.steps.length - 1, onActivate: () => up((d, s) => move(d, s, 1)) }
      : { id: 'laundry.confirm', label: v.step.confirm, onActivate: () => up((d, s) => confirmStep(d, s, undefined, v.step.id)) },
  ];
  const hint = v.step.kind === 'wash' && v.step.groupId ? 'Suggested; check your washer' : v.step.kind === 'set_aside' ? 'Show label or Explain for why' : undefined;
  return (
    <ContentScreen key={v.step.id} title={v.step.title} actions={actions} footer={
      <div data-g-fit-content className="g-coach-footer">
        {l.finished ? <span className="g-coach-status" role="status">Laundry done</span> : null}
        <Button title="More" alwaysShowText onClick={() => setPanel('menu')} />
      </div>
    }>
      <TextBlock label={`Step ${v.index + 1} of ${v.steps.length}${done ? ' ✓' : ''}`} text={v.step.text} hint={hint} />
      <Thumbs def={def} ids={v.step.garmentIds} data={data} />
    </ContentScreen>
  );
}

// ---------------------------------------------------------------- voice tools

const noArgs = { type: 'object' as const, properties: {}, required: [] };
const str = (v: unknown, max = 100) => (typeof v === 'string' && v.trim() && Array.from(v.trim()).length <= max ? v.trim() : null);

function laundryTools(def: AppletDefinition, host: Parameters<NonNullable<TaskModule['tools']>>[1], t: (n: string) => string, about: string): ToolDef[] {
  const data = dataOf(def);
  if (!data) return [];
  const session = () => host.session();
  const cardText = (l: LaundryState) => (l.card ? `${l.card.title}. ${l.card.lines.join(' ')}` : null);
  const garmentArg = (desc: string) => ({ type: 'string', description: desc });
  const run = async (fn: (d: LaundryData, s: LaundryState) => LaundryState) => updateLaundry(session(), fn);
  const garment = (spoken: unknown) => {
    const s = str(spoken);
    return s ? findGarment(data, s) : null;
  };
  const notFound = (spoken: unknown) => ({ error: 'unknown_garment', message: `I don’t have “${String(spoken ?? '')}” in this laundry session. Garments: ${data.garments.map((g) => g.name).join(', ')}.`, next_action: 'Tell the user and ask which garment, or to add it on their phone with its label.' });
  const reportTool = (name: string, kind: ReportKind, description: string, needsGarment: boolean): ToolDef => ({
    name: t(name), description,
    inputSchema: needsGarment ? { type: 'object', properties: { garment: garmentArg('The garment, as the user named it.') }, required: ['garment'] } : noArgs,
    annotations: { readOnlyHint: false },
    async execute(input) {
      const g = needsGarment ? garment(input?.garment) : null;
      if (needsGarment && !g) return notFound(input?.garment);
      const l = await run((d, s) => report(d, s, kind, { garmentId: g?.id ?? null, id: opId() }));
      if (l.clarify) return { ok: true, question: l.clarify.question, options: l.clarify.options, next_action: 'Ask the user this question with its options; they can also pick on the glasses.' };
      if (l.proposal) return { ok: true, proposal: l.proposal.title, details: l.proposal.lines, next_action: 'Describe the proposed change; the user confirms or keeps the plan on the glasses or by saying so.' };
      return { ok: true, info: cardText(l), next_action: 'Tell the user briefly.' };
    },
  });
  return [
    {
      name: t('laundry_status'), description: `Read the current laundry step, its garments and progress${about}.`, inputSchema: noArgs, annotations: { readOnlyHint: true },
      async execute() {
        const l = laundryOf(session().state.task);
        const v = view(data, l);
        return { ok: true, step: { number: v.index + 1, total: v.steps.length, text: v.step.text, confirmed: l.confirmed.includes(v.step.id) }, garments: v.step.garmentIds.map((id) => data.garments.find((g) => g.id === id)!.name), next_action: 'Answer briefly.' };
      },
    },
    {
      name: t('confirm_step'), description: `Confirm the current laundry step is done, e.g. "sorted", "done", "wash finished"${about}. Only when the user says so: nothing is detected automatically.`, inputSchema: noArgs, annotations: { readOnlyHint: false },
      async execute() {
        // The step on screen when the call arrived; a retried duplicate can't confirm the next one.
        const meant = view(data, laundryOf(session().state.task)).step.id;
        const l = await run((d, s) => confirmStep(d, s, undefined, meant));
        const v = view(data, l);
        return { ok: true, now: v.step.text, next_action: 'Confirm briefly and read the next step only if asked.' };
      },
    },
    ...(['next', 'previous'] as const).map((dir): ToolDef => ({
      name: t(`${dir}_step`), description: `Go to the ${dir} laundry step without confirming anything${about}.`, inputSchema: noArgs, annotations: { readOnlyHint: false },
      async execute() {
        const l = await run((d, s) => move(d, s, dir === 'next' ? 1 : -1));
        return { ok: true, now: view(data, l).step.text, next_action: 'Confirm briefly.' };
      },
    })),
    {
      name: t('undo_last'), description: `Undo the last confirmation or accepted plan change${about}.`, inputSchema: noArgs, annotations: { readOnlyHint: false },
      async execute() {
        const before = laundryOf(session().state.task);
        if (!before.undo.length) return { error: 'nothing_to_undo', message: 'There is nothing to undo.', next_action: 'Tell the user briefly.' };
        const l = await run((_, s) => undo(s));
        return { ok: true, now: view(data, l).step.text, next_action: 'Say what was undone in a few words.' };
      },
    },
    {
      name: t('show_label'), description: `Show a garment's confirmed care label${about}. Example: "show the sweater's label".`,
      inputSchema: { type: 'object', properties: { garment: garmentArg('The garment, as the user named it.') }, required: ['garment'] }, annotations: { readOnlyHint: false },
      async execute(input) {
        const g = garment(input?.garment);
        if (!g) return notFound(input?.garment);
        const l = await run((d, s) => showLabel(d, s, g.id));
        return { ok: true, label: cardText(l), next_action: 'Summarize the label in one sentence; it is on the glasses.' };
      },
    },
    {
      name: t('explain_grouping'), description: `Explain why the current group or pile is put together${about}.`, inputSchema: noArgs, annotations: { readOnlyHint: false },
      async execute() {
        const l = await run((d, s) => whyGroup(d, s));
        return { ok: true, explanation: cardText(l), next_action: 'Explain briefly from this text only.' };
      },
    },
    {
      name: t('why_separate'), description: `Explain why a garment is separate or in its group${about}. Example: "why is the sweater separate?".`,
      inputSchema: { type: 'object', properties: { garment: garmentArg('The garment, as the user named it.') }, required: ['garment'] }, annotations: { readOnlyHint: false },
      async execute(input) {
        const g = garment(input?.garment);
        if (!g) return notFound(input?.garment);
        const l = await run((d, s) => whySeparate(d, s, g.id));
        return { ok: true, explanation: cardText(l), next_action: 'Explain briefly from this text only; it cites the label.' };
      },
    },
    {
      name: t('can_go_together'), description: `Say whether two garments can be washed together, from their confirmed labels${about}. Example: "can the sweater go with my towels?".`,
      inputSchema: { type: 'object', properties: { garment: garmentArg('First garment.'), other: garmentArg('Second garment.') }, required: ['garment', 'other'] }, annotations: { readOnlyHint: false },
      async execute(input) {
        const a = garment(input?.garment), b = garment(input?.other);
        if (!a) return notFound(input?.garment);
        if (!b) return notFound(input?.other);
        const l = await run((d, s) => together(d, s, a.id, b.id));
        return { ok: true, answer: cardText(l), next_action: 'Answer from this text only. Do not suggest overriding a label.' };
      },
    },
    {
      name: t('symbol_meaning'), description: `Explain what a care-label symbol means${about}, e.g. "two bars under the tub", "a triangle with lines".`,
      inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'The symbol as the user described it.' } }, required: ['symbol'] }, annotations: { readOnlyHint: false },
      async execute(input) {
        const q = str(input?.symbol, 200);
        const meaning = q ? explainSymbol(q) : null;
        if (!meaning) return { error: 'unknown_symbol', message: 'I don’t recognize that symbol description.', next_action: 'Ask the user to describe its shape, or check the label on their phone.' };
        await run((_, s) => showCard(s, { title: 'Symbol', lines: [meaning, 'General meaning; the garment’s own label comes first.'] }));
        return { ok: true, meaning, next_action: 'Read the meaning briefly.' };
      },
    },
    reportTool('report_new', 'new', `The user says a garment is new (never washed)${about}. May ask its colour, then proposes a change they must confirm.`, true),
    reportTool('report_in_machine', 'in_machine', `The user already put a garment in the washer${about}, e.g. "I already put the sweater in the machine". Asks if the cycle started; never promises a rescue.`, true),
    reportTool('report_no_cycle', 'no_cycle', `The user's washer lacks the cycle the current group needs${about}. Asks which programs it has, then proposes a change.`, false),
    {
      name: t('choose_option'), description: `Answer the question the laundry coach is showing, with one of its options${about}.`,
      inputSchema: { type: 'object', properties: { option: { type: 'string', description: 'The option the user chose.' } }, required: ['option'] }, annotations: { readOnlyHint: false },
      async execute(input) {
        const c = laundryOf(session().state.task).clarify;
        if (!c) return { error: 'no_question', message: 'There is no question on the glasses.', next_action: 'Tell the user briefly.' };
        const want = str(input?.option, 100)?.toLowerCase() ?? '';
        const opt = c.options.find((o) => o.toLowerCase() === want) ?? c.options.find((o) => want && o.toLowerCase().includes(want));
        if (!opt) return { error: 'no_such_option', message: `Options: ${c.options.join('; ')}.`, next_action: 'Ask the user to pick one.' };
        const l = await run((d, s) => answer(d, s, opt));
        return l.proposal ? { ok: true, proposal: l.proposal.title, details: l.proposal.lines, next_action: 'Describe the proposal; the user must confirm it.' } : { ok: true, info: cardText(l), next_action: 'Tell the user briefly.' };
      },
    },
    {
      name: t('accept_change'), description: `Accept the proposed plan change shown on the glasses${about}. Only when the user clearly agrees.`, inputSchema: noArgs, annotations: { readOnlyHint: false },
      async execute() {
        const p = laundryOf(session().state.task).proposal;
        if (!p) return { error: 'no_proposal', message: 'There is no proposed change.', next_action: 'Tell the user briefly.' };
        await run((d, s) => accept(d, s, p.id));
        return { ok: true, changed: p.title, next_action: 'Say the plan was updated. Undo can revert it.' };
      },
    },
    {
      name: t('decline_change'), description: `Keep the current plan and drop the proposed change${about}.`, inputSchema: noArgs, annotations: { readOnlyHint: false },
      async execute() {
        if (!laundryOf(session().state.task).proposal) return { error: 'no_proposal', message: 'There is no proposed change.', next_action: 'Tell the user briefly.' };
        await run((_, s) => decline(s));
        return { ok: true, next_action: 'Say the plan stays as it was.' };
      },
    },
  ];
}

export const laundryModule: TaskModule = { kind: 'laundry', version: 1, Screen: LaundryScreen, tools: laundryTools };
