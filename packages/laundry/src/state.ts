import type { ColorClass, Garment, LaundryData } from './care.ts';
import { canWashTogether, explainGarment, explainGroup, labelLines, type Explanation } from './explain.ts';
import { planSteps, type Step } from './guide.ts';
import { buildPlan, classify, garmentName, type Override, type Plan } from './plan.ts';
import { washText } from './symbols.ts';

/**
 * Laundry session on the glasses: pure transitions over `AppletState.task`.
 * - The plan is always rebuilt from the confirmed garments plus accepted
 *   overrides, so the original plan and every adaptation stay reproducible.
 * - Only explicit confirmations are tracked. Repeating a confirmation is a
 *   no-op; Undo restores the previous snapshot (including an adaptation).
 * - Wearer reports ask a clarifying question when needed, then show a
 *   proposal; nothing moves until the wearer accepts it.
 * - Requests with an operation ID apply once.
 */

export interface Proposal { id: string; title: string; lines: string[]; overrides: Override[]; moves: { garmentId: string; from: string; to: string }[] }
export interface Clarify { id: string; kind: ReportKind; garmentId: string | null; groupId: string | null; question: string; options: string[] }
export type ReportKind = 'new' | 'in_machine' | 'no_cycle';

interface Snapshot { accepted: Override[][]; confirmed: string[]; stepId: string | null }

export interface LaundryState {
  version: 1;
  accepted: Override[][];
  confirmed: string[];
  stepId: string | null;
  finished: boolean;
  undo: Snapshot[];
  history: { title: string; outcome: 'accepted' | 'declined' | 'undone' | 'reported'; planVersion: number }[];
  clarify: Clarify | null;
  proposal: Proposal | null;
  card: Explanation | null;
  applied: string[];
}

const MAX_UNDO = 30;

export function emptyLaundry(): LaundryState {
  return { version: 1, accepted: [], confirmed: [], stepId: null, finished: false, undo: [], history: [], clarify: null, proposal: null, card: null, applied: [] };
}

export function laundryOf(task: Record<string, unknown> | undefined): LaundryState {
  const s = task?.laundry as LaundryState | undefined;
  return s && s.version === 1 ? s : emptyLaundry();
}

export interface View { plan: Plan; steps: Step[]; step: Step; index: number; garments: Garment[]; planVersion: number }

export function view(data: LaundryData, s: LaundryState): View {
  const plan = buildPlan(data.garments, s.accepted.flat());
  const steps = planSteps(plan, data.garments);
  const firstOpen = steps.findIndex((x) => !s.confirmed.includes(x.id));
  const at = s.stepId ? steps.findIndex((x) => x.id === s.stepId) : -1;
  const index = at >= 0 ? at : Math.max(0, firstOpen);
  return { plan, steps, step: steps[index]!, index, garments: data.garments, planVersion: s.accepted.length };
}

function snap(s: LaundryState): Snapshot {
  return { accepted: s.accepted, confirmed: s.confirmed, stepId: s.stepId };
}
function pushUndo(s: LaundryState): Snapshot[] {
  return [...s.undo, snap(s)].slice(-MAX_UNDO);
}
function once(s: LaundryState, opId: string | undefined): boolean {
  return !!opId && s.applied.includes(opId);
}
function mark(s: LaundryState, opId: string | undefined): string[] {
  return opId ? [...s.applied, opId].slice(-60) : s.applied;
}

/**
 * Confirms the current step and moves on. Confirming an already confirmed
 * step changes nothing. `stepId` is the step the wearer meant (captured when
 * they tapped or spoke): a duplicate arriving after the screen moved on is
 * ignored instead of confirming the next step.
 */
export function confirmStep(data: LaundryData, s: LaundryState, opId?: string, stepId?: string): LaundryState {
  if (once(s, opId)) return s;
  const v = view(data, s);
  if (stepId && v.step.id !== stepId) return opId ? { ...s, applied: mark(s, opId) } : s;
  if (s.confirmed.includes(v.step.id)) return opId ? { ...s, applied: mark(s, opId) } : s;
  const next = v.steps[Math.min(v.index + 1, v.steps.length - 1)]!;
  return { ...s, undo: pushUndo(s), confirmed: [...s.confirmed, v.step.id], stepId: next.id, finished: s.finished || v.step.kind === 'complete', card: null, applied: mark(s, opId) };
}

export function move(data: LaundryData, s: LaundryState, by: 1 | -1): LaundryState {
  const v = view(data, s);
  const to = v.steps[Math.min(Math.max(0, v.index + by), v.steps.length - 1)]!;
  return to.id === v.step.id ? s : { ...s, stepId: to.id, card: null };
}

/** Reverts the last confirmation or accepted change. */
export function undo(s: LaundryState): LaundryState {
  const last = s.undo.at(-1);
  if (!last) return s;
  const undone = s.accepted.length > last.accepted.length;
  return {
    ...s, ...last, undo: s.undo.slice(0, -1), finished: false, card: null, proposal: null, clarify: null,
    history: undone ? [...s.history, { title: 'Undid the last plan change', outcome: 'undone', planVersion: last.accepted.length }] : s.history,
  };
}

export function showCard(s: LaundryState, card: Explanation): LaundryState {
  return { ...s, card };
}
export function dismiss(s: LaundryState): LaundryState {
  return s.card || s.clarify ? { ...s, card: null, clarify: null } : s;
}

// ---------------------------------------------------------------- questions (local)

export function whySeparate(data: LaundryData, s: LaundryState, garmentId: string): LaundryState {
  return showCard(s, explainGarment(view(data, s).plan, data.garments, garmentId));
}
export function whyGroup(data: LaundryData, s: LaundryState): LaundryState {
  const v = view(data, s);
  return showCard(s, v.step.groupId ? explainGroup(v.plan, data.garments, v.step.groupId) : v.step.garmentIds[0] ? explainGarment(v.plan, data.garments, v.step.garmentIds[0]) : { title: 'Nothing to explain', lines: ['This step has no garments.'] });
}
export function together(data: LaundryData, s: LaundryState, a: string, b: string): LaundryState {
  return showCard(s, canWashTogether(view(data, s).plan, data.garments, a, b));
}
export function showLabel(data: LaundryData, s: LaundryState, garmentId: string): LaundryState {
  const g = data.garments.find((x) => x.id === garmentId);
  return showCard(s, g ? { title: `${g.name} label`, lines: [...labelLines(g), 'From the maker’s care label as you confirmed it.'] } : { title: 'Not in this plan', lines: ['That garment isn’t in this session.'] });
}

/** Finds a garment by what the wearer called it ("the sweater", "blue sweater", "towels"). */
export function findGarment(data: LaundryData, spoken: string): Garment | null {
  const want = spoken.toLowerCase().replace(/^(the|my)\s+/, '').trim();
  if (!want) return null;
  return data.garments.find((g) => g.id === want || g.name.toLowerCase() === want)
    ?? data.garments.find((g) => g.name.toLowerCase().includes(want) || want.includes(g.name.toLowerCase()))
    ?? data.garments.find((g) => want.split(/\s+/).some((w) => w.length > 3 && g.name.toLowerCase().includes(w.replace(/s$/, ''))))
    ?? null;
}

// ---------------------------------------------------------------- reports → clarify → proposal

/** "This garment is new" / "I already put X in the machine" / "My washer doesn't have that cycle". */
export function report(data: LaundryData, s: LaundryState, kind: ReportKind, opts: { garmentId?: string | null; groupId?: string | null; id: string }): LaundryState {
  if (once(s, opts.id)) return s;
  const v = view(data, s);
  const g = opts.garmentId ? data.garments.find((x) => x.id === opts.garmentId) : null;
  const base = { ...s, applied: mark(s, opts.id), card: null, proposal: null };
  if (kind === 'new') {
    if (!g) return { ...base, card: { title: 'Which garment?', lines: ['Say or pick which garment is new.'] } };
    const color = v.garments.find((x) => x.id === g.id)!.info.color;
    if (color === 'unknown') return { ...base, clarify: { id: opts.id, kind, garmentId: g.id, groupId: null, question: `What colour is ${g.name}?`, options: ['Dark or bright', 'White or light', 'Not sure'] } };
    return { ...base, clarify: null, ...proposeNew(data, s, g, color, opts.id) };
  }
  if (kind === 'in_machine') {
    if (!g) return { ...base, card: { title: 'Which garment?', lines: ['Say or pick the garment you put in.'] } };
    const groupId = opts.groupId ?? v.step.groupId;
    const group = v.plan.washGroups.find((w) => w.id === groupId);
    if (group && v.plan.placements[g.id]?.washGroup === group.id) return { ...base, card: { title: 'That’s its group', lines: [`${g.name} belongs in Group ${group.number}. Nothing to change.`] } };
    return { ...base, clarify: { id: opts.id, kind, garmentId: g.id, groupId: group?.id ?? null, question: `Has the cycle with ${g.name} started?`, options: ['Not yet, I took it out', 'Yes, it’s running', 'It’s finished'] } };
  }
  const group = v.plan.washGroups.find((w) => w.id === (opts.groupId ?? v.step.groupId));
  if (!group) return { ...base, card: { title: 'Which group?', lines: ['Open the wash step whose cycle your washer lacks, then report it.'] } };
  const options = group.cycle === 'delicate' ? ['A wool or hand-wash program', 'None of these'] : group.cycle === 'permanent_press' ? ['A delicate or gentle program', 'None of these'] : ['None of these'];
  return { ...base, clarify: { id: opts.id, kind, garmentId: null, groupId: group.id, question: `Group ${group.number} needs a ${group.cycle.replace('_', ' ')} cycle. Which does your washer have?`, options } };
}

function proposeNew(data: LaundryData, s: LaundryState, g: Garment, color: ColorClass, id: string): Pick<LaundryState, 'proposal'> {
  const overrides: Override[] = [{ garmentId: g.id, isNew: true, colorfast: null, ...(color !== g.info.color ? { color } : {}) }];
  return { proposal: proposal(data, s, id, `Mark ${g.name} as new`, overrides, color === 'dark' || color === 'bright' ? ['New dark or bright garments can release dye, so it washes alone the first time.'] : ['Light or white: it can stay where it is.']) };
}

function proposal(data: LaundryData, s: LaundryState, id: string, title: string, overrides: Override[], lines: string[]): Proposal {
  const before = buildPlan(data.garments, s.accepted.flat());
  const after = buildPlan(data.garments, [...s.accepted.flat(), ...overrides]);
  const where = (p: Plan, gid: string) => {
    const pl = p.placements[gid]!;
    return pl.washGroup ? `Group ${p.washGroups.find((w) => w.id === pl.washGroup)!.number}` : pl.handling.replace(/_/g, ' ');
  };
  const moves = data.garments
    .filter((g) => before.placements[g.id]!.washGroup !== after.placements[g.id]!.washGroup || before.placements[g.id]!.handling !== after.placements[g.id]!.handling)
    .map((g) => ({ garmentId: g.id, from: where(before, g.id), to: where(after, g.id) }));
  const moveLines = moves.map((m) => `${garmentName(data.garments, m.garmentId)}: ${m.from} → ${m.to}`);
  return { id, title, lines: [...lines, ...(moveLines.length ? moveLines : ['No garment changes group.'])], overrides, moves };
}

export function answer(data: LaundryData, s: LaundryState, option: string): LaundryState {
  const c = s.clarify;
  if (!c || !c.options.includes(option)) return s;
  const g = c.garmentId ? data.garments.find((x) => x.id === c.garmentId)! : null;
  const cleared = { ...s, clarify: null };
  if (c.kind === 'new' && g) {
    const color: ColorClass = option === 'White or light' ? 'light' : 'dark'; // Not sure → treat as dark (cautious)
    return { ...cleared, ...proposeNew(data, s, g, color, c.id) };
  }
  if (c.kind === 'in_machine' && g) {
    const label = g.label.wash.value ? washText(g.label.wash.value) : 'no washing instruction';
    if (option === 'Not yet, I took it out') return { ...cleared, card: { title: 'Plan unchanged', lines: [`Keep ${g.name} out. Its label: ${label}.`] }, history: [...s.history, { title: `${g.name} taken out before the cycle`, outcome: 'reported', planVersion: s.accepted.length }] };
    const known = classify(g).handling === 'machine' ? 'Its label allows machine washing, but at different settings.' : `Its label says: ${label}.`;
    return {
      ...cleared,
      proposal: proposal(data, s, c.id, `Check ${g.name} after washing`, [{ garmentId: g.id, checkAfterWash: true }], [
        known,
        'I can’t tell what the cycle will do to it. There’s no rescue step I can promise.',
        'Check it when the cycle ends; follow its care label and your washer’s instructions.',
      ]),
    };
  }
  if (c.kind === 'no_cycle' && c.groupId) {
    const v = view(data, s);
    const group = v.plan.washGroups.find((w) => w.id === c.groupId);
    if (!group) return cleared;
    if (option === 'None of these')
      return { ...cleared, proposal: proposal(data, s, c.id, `Hand wash Group ${group.number} instead`, group.garmentIds.map((id) => ({ garmentId: id, handWash: true })), ['Hand washing is gentler than the cycle these labels allow. Follow each label’s temperature.']) };
    const cycleName = option === 'A wool or hand-wash program' ? 'Wool or hand-wash program' : 'Delicate/gentle program';
    return { ...cleared, proposal: proposal(data, s, c.id, `Use your washer’s ${cycleName.toLowerCase()}`, group.garmentIds.map((id) => ({ garmentId: id, cycleName })), [`General suggestion: a ${cycleName.toLowerCase()} is at least as gentle. Keep to ${group.maxTempC}°C or lower. Check your washer’s manual.`]) };
  }
  return cleared;
}

/** Accepts the proposal: the original plan stays in history and Undo can revert it. */
export function accept(data: LaundryData, s: LaundryState, proposalId?: string): LaundryState {
  const p = s.proposal;
  if (!p || (proposalId && p.id !== proposalId)) return s;
  const accepted = [...s.accepted, p.overrides];
  const nextSteps = planSteps(buildPlan(data.garments, accepted.flat()), data.garments);
  const before = view(data, s);
  // Keep confirmations for steps that still exist with the same garments.
  const confirmed = s.confirmed.filter((id) => {
    const old = before.steps.find((x) => x.id === id), now = nextSteps.find((x) => x.id === id);
    return !!old && !!now && old.garmentIds.join() === now.garmentIds.join();
  });
  const stepId = nextSteps.some((x) => x.id === s.stepId) ? s.stepId : (nextSteps.find((x) => !confirmed.includes(x.id)) ?? nextSteps[0]!).id;
  return { ...s, undo: pushUndo(s), accepted, confirmed, stepId, proposal: null, card: null, history: [...s.history, { title: p.title, outcome: 'accepted', planVersion: accepted.length }] };
}

export function decline(s: LaundryState): LaundryState {
  return s.proposal ? { ...s, proposal: null, history: [...s.history, { title: s.proposal.title, outcome: 'declined', planVersion: s.accepted.length }] } : s;
}
