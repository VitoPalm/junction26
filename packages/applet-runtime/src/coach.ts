import type { AppletDefinition, GuideExcerpt, GuidePart, SequenceStep, SourceRef } from '@junction26/applet-format';
import type { AppletState } from './index.ts';

/**
 * Task coach: pure state and grounding helpers for guides made from a manual
 * (definitions with a `guide` block). Shared by the glasses, the authoring
 * preview and the worker. No I/O, clocks or randomness: hosts pass request IDs
 * and times in.
 *
 * Invariants:
 * - The original guide is never edited. A recovery branch is a separate,
 *   temporary path that returns to a step of the original guide.
 * - Completed steps are only ever added to, never removed.
 * - Every request and result is keyed by an operation ID, so a retried voice
 *   call, a double tap or a re-delivered job result applies once.
 */

// ---------------------------------------------------------------- state

export type CoachRequestKind = 'question' | 'problem';
export type CoachRequestStatus = 'pending' | 'done' | 'failed' | 'cancelled';

export interface CoachRequest {
  /** Operation ID chosen by the host; also the server idempotency key. */
  id: string;
  kind: CoachRequestKind;
  /** What the wearer asked or reported, plus any clarification answers. */
  text: string;
  clarifications: string[];
  stepId: string;
  status: CoachRequestStatus;
  /** Server job, once the request reached the API. */
  jobId: string | null;
  error: string | null;
  createdAt: string;
}

export interface CoachAnswer {
  requestId: string | null;
  /** `failed`: the request couldn't be completed (offline for good, not paired...), not a claim about the manual. */
  status: 'answered' | 'insufficient' | 'clarify' | 'failed';
  text: string;
  sources: SourceRef[];
  /** Answered from structured content on the device, without the network. */
  local: boolean;
  /** For `clarify`: choices the wearer can pick with the band. */
  options: string[];
}

export interface RecoveryStep {
  text: string;
  source: SourceRef | null;
}

export interface RecoveryBranch {
  id: string;
  requestId: string;
  status: 'proposed' | 'active';
  title: string;
  rationale: string;
  steps: RecoveryStep[];
  sources: SourceRef[];
  /** Original-guide step to go back to when the branch is done. */
  returnStepId: string;
  /** Original-guide step the problem was reported on. */
  fromStepId: string;
  /** Position within `steps` while active. */
  index: number;
}

export interface CoachState {
  completed: string[];
  finished: boolean;
  requests: CoachRequest[];
  answer: CoachAnswer | null;
  /** A problem that needs a clarification before a fix can be proposed. */
  clarify: { requestId: string; question: string; options: string[] } | null;
  branch: RecoveryBranch | null;
  /** Finished or cancelled branches, kept for review. */
  history: { title: string; returnStepId: string; outcome: 'returned' | 'cancelled' }[];
  /** Results already applied (request IDs), newest last. */
  applied: string[];
  /** A coach panel over the step, opened by voice or the band. */
  panel?: 'parts' | null;
}

const MAX_REQUESTS = 12;
const MAX_APPLIED = 60;
const MAX_HISTORY = 20;

export function emptyCoach(): CoachState {
  return { completed: [], finished: false, requests: [], answer: null, clarify: null, branch: null, history: [], applied: [] };
}

export function coachOf(state: AppletState): CoachState {
  return state.coach ?? emptyCoach();
}

function withCoach(state: AppletState, coach: CoachState): AppletState {
  return { ...state, coach };
}

// ---------------------------------------------------------------- guide access

export interface GuideStep {
  step: SequenceStep;
  index: number;
  total: number;
  parts: GuidePart[];
  excerpts: GuideExcerpt[];
}

export function hasGuide(def: AppletDefinition): boolean {
  return !!def.guide && def.views.some((v) => v.id === def.guide!.sequence && v.kind === 'sequence');
}

function sequenceOf(def: AppletDefinition) {
  const v = def.guide ? def.views.find((x) => x.id === def.guide!.sequence) : undefined;
  return v?.kind === 'sequence' ? v : null;
}

/** The step the wearer is on in the original guide. */
export function currentStep(def: AppletDefinition, state: AppletState): GuideStep | null {
  const seq = sequenceOf(def);
  if (!seq || !def.guide) return null;
  const index = Math.min(Math.max(0, Number(state.values[seq.cursor] ?? 0) || 0), seq.steps.length - 1);
  return stepAt(def, index);
}

export function stepAt(def: AppletDefinition, index: number): GuideStep | null {
  const seq = sequenceOf(def);
  const step = seq?.steps[index];
  if (!seq || !step || !def.guide) return null;
  const parts = (step.parts ?? []).map((id) => def.guide!.parts.find((p) => p.id === id)).filter((p): p is GuidePart => !!p);
  return { step, index, total: seq.steps.length, parts, excerpts: def.guide.excerpts.filter((e) => e.stepId === step.id) };
}

export function stepIndex(def: AppletDefinition, stepId: string): number {
  return sequenceOf(def)?.steps.findIndex((s) => s.id === stepId) ?? -1;
}

function setCursor(def: AppletDefinition, state: AppletState, index: number): AppletState {
  const seq = sequenceOf(def);
  if (!seq) return state;
  const i = Math.min(Math.max(0, index), seq.steps.length - 1);
  return state.values[seq.cursor] === i ? state : { ...state, values: { ...state.values, [seq.cursor]: i } };
}

export function formatSource(s: SourceRef | null | undefined): string {
  if (!s) return '';
  return [s.page !== undefined ? `p. ${s.page}` : '', s.section ?? ''].filter(Boolean).join(', ');
}

export function partLabel(p: GuidePart): string {
  return `${p.quantity ? `${p.quantity} × ` : ''}${p.label}${p.detail ? ` (${p.detail})` : ''}`;
}

// ---------------------------------------------------------------- read-only context

/**
 * The small read-only interface the coach exposes (to voice tools and to the
 * backend request): current step, its parts, its source excerpts and progress.
 * Nothing else about the wearer or other applets.
 */
export function coachContext(def: AppletDefinition, state: AppletState) {
  const cur = currentStep(def, state);
  const coach = coachOf(state);
  if (!cur) return null;
  const branch = coach.branch;
  return {
    guide: def.title,
    source: def.guide?.sourceTitle ?? null,
    step: {
      id: cur.step.id,
      number: cur.index + 1,
      total: cur.total,
      title: cur.step.title ?? null,
      instruction: cur.step.text ?? cur.step.alt ?? null,
      warning: cur.step.warning ?? null,
      flag: cur.step.flag ? { kind: cur.step.flag, note: cur.step.flagNote ?? null } : null,
      source: cur.step.source ?? null,
    },
    parts: cur.parts.map((p) => ({ label: p.label, quantity: p.quantity ?? null, detail: p.detail ?? null })),
    excerpts: cur.excerpts.map((e) => ({ text: e.text, source: e.source })),
    progress: { completed: coach.completed.length, total: cur.total, finished: coach.finished },
    recovery: branch ? { status: branch.status, title: branch.title, step: branch.status === 'active' ? branch.index + 1 : null, steps: branch.steps.length } : null,
  };
}

// ---------------------------------------------------------------- local answers

const PARTS_Q = /\b(which|what|how many)\b.*\b(screws?|bolts?|parts?|pieces?|nails?|dowels?|locks?|brackets?|hardware|panels?|shelf|shelves|need)\b|\b(show|list)\b.*\bparts?\b/i;
const WARNING_Q = /\b(careful|warnings?|cautions?|safe|safety|danger(ous)?|risk)\b/i;
const PROGRESS_Q = /\b(how many steps|steps? (are )?left|where am i|which step|what step|progress|how far)\b/i;
const REPEAT_Q = /\b(repeat|again|what do i do|what('s| is) (this|the) step|read (it|the step))\b/i;

/**
 * Answers from structured content when the question is one of the common
 * kinds (parts, warnings, progress, repeat). Returns null when it needs the
 * manual's text and inference, which goes to the backend.
 */
export function answerLocally(def: AppletDefinition, state: AppletState, question: string): CoachAnswer | null {
  const cur = currentStep(def, state);
  if (!cur) return null;
  const q = question.trim();
  const src = cur.step.source ?? null;
  const answer = (text: string, sources: (SourceRef | null | undefined)[], status: CoachAnswer['status'] = 'answered'): CoachAnswer => ({
    requestId: null, status, text, sources: uniqueSources(sources), local: true, options: [],
  });
  if (PROGRESS_Q.test(q)) {
    const done = coachOf(state).completed.length;
    return answer(`Step ${cur.index + 1} of ${cur.total}. ${done} done, ${cur.total - cur.index - 1} after this one.`, [src]);
  }
  if (PARTS_Q.test(q)) {
    if (!cur.parts.length) return answer('The manual lists no parts for this step.', [src], 'insufficient');
    return answer(`This step uses: ${cur.parts.map(partLabel).join('; ')}.`, [src, ...cur.parts.map((p) => p.source)]);
  }
  if (WARNING_Q.test(q)) {
    if (cur.step.warning) return answer(cur.step.warning, [src]);
    return null; // General safety questions need the manual's other text.
  }
  if (REPEAT_Q.test(q)) return answer(repeatText(cur), [src]);
  return null;
}

/** What "Repeat" says: the instruction, its caution and any flag. */
export function repeatText(cur: GuideStep): string {
  const flag = cur.step.flag ? ` Note: ${cur.step.flagNote ?? `the manual is ${cur.step.flag} here`}.` : '';
  return [`Step ${cur.index + 1}: ${cur.step.text ?? cur.step.alt ?? cur.step.title ?? ''}`.trim(), cur.step.warning ? `Caution: ${cur.step.warning}` : '', flag.trim()]
    .filter(Boolean)
    .join(' ');
}

function uniqueSources(list: (SourceRef | null | undefined)[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const s of list) {
    if (!s) continue;
    const k = `${s.page ?? ''}|${s.section ?? ''}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

// ---------------------------------------------------------------- retrieval (used by the worker)

const STOP = new Set('a an and are be can do does for from how i if in into is it its me my of on or should the this to what when where which who why will with you your'.split(' '));
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 1 && !STOP.has(w)) ?? [];

export interface Passage {
  /** Stable within one request: "s<stepIndex>" for a step, "e<excerptIndex>" for an excerpt. */
  id: string;
  text: string;
  source: SourceRef;
  stepId: string | null;
}

/** Every citable passage: step instructions and the manual's verbatim excerpts. */
export function passages(def: AppletDefinition): Passage[] {
  const seq = sequenceOf(def);
  if (!seq || !def.guide) return [];
  const out: Passage[] = [];
  seq.steps.forEach((s, i) => {
    if (s.source) out.push({ id: `s${i}`, text: [s.title, s.text, s.warning].filter(Boolean).join('. '), source: s.source, stepId: s.id });
  });
  def.guide.excerpts.forEach((e, i) => out.push({ id: `e${i}`, text: e.text, source: e.source, stepId: e.stepId ?? null }));
  return out;
}

/**
 * Keyword retrieval: passages sharing the most question words, with a boost
 * for the current step. Small and deterministic; enough for one manual.
 */
export function retrieve(def: AppletDefinition, question: string, stepId: string | null, limit = 6): (Passage & { score: number })[] {
  const q = new Set(words(question));
  return passages(def)
    .map((p) => {
      const w = new Set(words(p.text));
      let score = 0;
      for (const x of q) if (w.has(x) || w.has(x.replace(/s$/, ''))) score += 1;
      if (stepId && p.stepId === stepId) score += 0.5;
      return { ...p, score };
    })
    .filter((p) => p.score >= 1)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

// ---------------------------------------------------------------- model output checks (used by the worker)

export interface AnswerOutput {
  status: 'answered' | 'insufficient' | 'clarify';
  answer: string;
  sourceIds: string[];
  options?: string[];
}

/**
 * Checks a model's answer against the passages it was given: answered means
 * at least one real citation, short text and no invented source IDs.
 * Anything else becomes "the manual doesn't establish this".
 */
export function checkAnswer(out: AnswerOutput, given: Passage[]): Omit<CoachAnswer, 'requestId' | 'local'> {
  const byId = new Map(given.map((p) => [p.id, p]));
  const cited = (out.sourceIds ?? []).map((id) => byId.get(id)).filter((p): p is Passage => !!p);
  const text = String(out.answer ?? '').trim().slice(0, 160);
  if (out.status === 'clarify' && text) return { status: 'clarify', text, sources: [], options: (out.options ?? []).map(String).filter(Boolean).slice(0, 3).map((o) => o.slice(0, 28)) };
  if (out.status === 'answered' && text && cited.length && cited.length === (out.sourceIds ?? []).length)
    return { status: 'answered', text, sources: uniqueSources(cited.map((p) => p.source)), options: [] };
  return { status: 'insufficient', text: NOT_ESTABLISHED, sources: [], options: [] };
}

export const NOT_ESTABLISHED = 'The manual doesn’t say. Check with the retailer or manufacturer.';

export interface RecoveryOutput {
  status: 'proposal' | 'clarify' | 'unsupported';
  question?: string;
  options?: string[];
  title?: string;
  rationale?: string;
  steps?: { text: string; sourceId: string }[];
  returnStepId?: string;
  message?: string;
}

export type CheckedRecovery =
  | { status: 'proposal'; title: string; rationale: string; steps: RecoveryStep[]; returnStepId: string; sources: SourceRef[] }
  | { status: 'clarify'; question: string; options: string[] }
  | { status: 'unsupported'; message: string };

/**
 * Safety-critical problems are never answered with generated repair steps:
 * the coach says to stop and get help instead.
 */
const SAFETY = /\b(broken|broke|crack(ed)?|snapped|split|injur(ed|y)|cut myself|bleed|electric(al)?|wires?|gas|fell|falling|tipp?(ed|ing)? over|wobbl(y|es|ing)|unstable|collaps)/i;

export function isSafetyCritical(text: string): boolean {
  return SAFETY.test(text);
}

export const STOP_AND_GET_HELP = 'Stop here. The manual doesn’t cover this safely. Contact the retailer before you continue.';

/**
 * Checks a proposed recovery branch: it returns to a real step at or before
 * the one the problem was reported on, every step cites a passage it was
 * given, and copy fits the display. Fails closed to "unsupported".
 */
export function checkRecovery(def: AppletDefinition, out: RecoveryOutput, given: Passage[], fromStepId: string): CheckedRecovery {
  if (out.status === 'clarify' && out.question?.trim())
    return { status: 'clarify', question: out.question.trim().slice(0, 120), options: (out.options ?? []).map(String).filter(Boolean).slice(0, 3).map((o) => o.slice(0, 28)) };
  if (out.status !== 'proposal') return { status: 'unsupported', message: (out.message ?? '').trim().slice(0, 120) || NOT_ESTABLISHED };
  const byId = new Map(given.map((p) => [p.id, p]));
  const from = stepIndex(def, fromStepId);
  const ret = stepIndex(def, out.returnStepId ?? '');
  const steps = out.steps ?? [];
  const fail = (why: string): CheckedRecovery => ({ status: 'unsupported', message: `${NOT_ESTABLISHED} (${why})` });
  if (from < 0) return fail('unknown step');
  if (ret < 0 || ret > from) return fail('no safe return point');
  if (!steps.length || steps.length > 6) return fail('no usable steps');
  const checked: RecoveryStep[] = [];
  for (const s of steps) {
    const p = byId.get(s.sourceId);
    const text = String(s.text ?? '').trim();
    if (!p || !text || Array.from(text).length > 120) return fail('a step had no source');
    checked.push({ text, source: p.source });
  }
  const title = String(out.title ?? '').trim().slice(0, 32) || 'Fix the problem';
  const rationale = String(out.rationale ?? '').trim().slice(0, 120);
  return { status: 'proposal', title, rationale, steps: checked, returnStepId: out.returnStepId!, sources: uniqueSources(checked.map((s) => s.source)) };
}

// ---------------------------------------------------------------- transitions

/** Marks the current step done and moves on; on the last step, finishes the guide. */
export function completeCurrent(def: AppletDefinition, state: AppletState): AppletState {
  const cur = currentStep(def, state);
  if (!cur) return state;
  const coach = coachOf(state);
  const completed = coach.completed.includes(cur.step.id) ? coach.completed : [...coach.completed, cur.step.id];
  const last = cur.index === cur.total - 1;
  const next = withCoach(state, { ...coach, completed, finished: coach.finished || last, answer: null });
  return last ? next : setCursor(def, next, cur.index + 1);
}

/** Records a new request. A repeated operation ID returns the state unchanged. */
export function startRequest(state: AppletState, req: { id: string; kind: CoachRequestKind; text: string; stepId: string; createdAt: string; clarifications?: string[] }): AppletState {
  const coach = coachOf(state);
  if (coach.requests.some((r) => r.id === req.id)) return state;
  const request: CoachRequest = { ...req, clarifications: req.clarifications ?? [], status: 'pending', jobId: null, error: null };
  const requests = [...coach.requests.filter((r) => r.status === 'pending' || r.kind !== req.kind), request].slice(-MAX_REQUESTS);
  return withCoach(state, { ...coach, requests, answer: null, clarify: req.kind === 'problem' ? null : coach.clarify });
}

export function pendingRequest(state: AppletState, kind?: CoachRequestKind): CoachRequest | null {
  return [...coachOf(state).requests].reverse().find((r) => r.status === 'pending' && (!kind || r.kind === kind)) ?? null;
}

export function setRequestJob(state: AppletState, id: string, jobId: string): AppletState {
  return updateRequest(state, id, (r) => (r.status === 'pending' && r.jobId !== jobId ? { ...r, jobId, error: null } : r));
}

/** A transient failure (offline, server error): the request stays pending so Retry can resend it. */
export function setRequestError(state: AppletState, id: string, error: string | null): AppletState {
  return updateRequest(state, id, (r) => (r.status === 'pending' && r.error !== error ? { ...r, error } : r));
}

/** A permanent failure: the request ends and the wearer sees why (the guide itself is unaffected). */
export function failRequest(state: AppletState, id: string, error: string): AppletState {
  const next = updateRequest(state, id, (r) => (r.status === 'pending' ? { ...r, status: 'failed', error } : r));
  if (next === state) return state;
  return withCoach(next, { ...coachOf(next), answer: { requestId: id, status: 'failed', text: `Couldn’t check the manual: ${error}`, sources: [], local: true, options: [] } });
}

export function cancelRequest(state: AppletState, id: string): AppletState {
  return updateRequest(state, id, (r) => (r.status === 'pending' ? { ...r, status: 'cancelled' } : r));
}

function updateRequest(state: AppletState, id: string, fn: (r: CoachRequest) => CoachRequest): AppletState {
  const coach = coachOf(state);
  let changed = false;
  const requests = coach.requests.map((r) => {
    if (r.id !== id) return r;
    const n = fn(r);
    if (n !== r) changed = true;
    return n;
  });
  return changed ? withCoach(state, { ...coach, requests }) : state;
}

/** Shows an answer that didn't need the network. */
export function showLocalAnswer(state: AppletState, answer: CoachAnswer): AppletState {
  return withCoach(state, { ...coachOf(state), answer });
}

export function setPanel(state: AppletState, panel: 'parts' | null): AppletState {
  const coach = coachOf(state);
  return (coach.panel ?? null) === panel ? state : withCoach(state, { ...coach, panel });
}

export function dismissAnswer(state: AppletState): AppletState {
  const coach = coachOf(state);
  return coach.answer || coach.clarify ? withCoach(state, { ...coach, answer: null, clarify: coach.clarify && coach.requests.some((r) => r.id === coach.clarify!.requestId && r.kind === 'question') ? null : coach.clarify }) : state;
}

/**
 * Applies a finished request's result once. Results for cancelled, unknown or
 * already-applied requests are ignored, and a proposal never replaces a
 * branch the wearer already activated.
 */
export function applyResult(
  def: AppletDefinition,
  state: AppletState,
  requestId: string,
  result: { kind: 'question'; answer: Omit<CoachAnswer, 'requestId' | 'local'> } | { kind: 'problem'; recovery: CheckedRecovery },
): AppletState {
  const coach = coachOf(state);
  const req = coach.requests.find((r) => r.id === requestId);
  if (!req || req.status !== 'pending' || coach.applied.includes(requestId) || req.kind !== result.kind) return state;
  const requests = coach.requests.map((r) => (r.id === requestId ? { ...r, status: 'done' as const, error: null } : r));
  const applied = [...coach.applied, requestId].slice(-MAX_APPLIED);
  const base: CoachState = { ...coach, requests, applied };
  if (result.kind === 'question') {
    const a = result.answer;
    return withCoach(state, { ...base, answer: { ...a, requestId, local: false }, clarify: a.status === 'clarify' ? { requestId, question: a.text, options: a.options } : null });
  }
  const r = result.recovery;
  if (r.status === 'clarify') return withCoach(state, { ...base, clarify: { requestId, question: r.question, options: r.options }, answer: null });
  if (r.status === 'unsupported')
    return withCoach(state, { ...base, clarify: null, answer: { requestId, status: 'insufficient', text: r.message, sources: [], local: false, options: [] } });
  if (coach.branch?.status === 'active')
    return withCoach(state, { ...base, answer: { requestId, status: 'insufficient', text: 'Finish or cancel the current fix first.', sources: [], local: false, options: [] } });
  if (stepIndex(def, r.returnStepId) < 0) return withCoach(state, base);
  const branch: RecoveryBranch = { id: `fix_${requestId}`, requestId, status: 'proposed', title: r.title, rationale: r.rationale, steps: r.steps, sources: r.sources, returnStepId: r.returnStepId, fromStepId: req.stepId, index: 0 };
  return withCoach(state, { ...base, clarify: null, answer: null, branch });
}

/** The wearer accepted the proposed fix. Only an explicit confirmation activates it. */
export function confirmBranch(state: AppletState, branchId?: string): AppletState {
  const coach = coachOf(state);
  const b = coach.branch;
  if (!b || b.status !== 'proposed' || (branchId && b.id !== branchId)) return state;
  return withCoach(state, { ...coach, branch: { ...b, status: 'active', index: 0 } });
}

/** Declines a proposal or abandons an active fix. The original guide and progress are untouched. */
export function cancelBranch(def: AppletDefinition, state: AppletState): AppletState {
  const coach = coachOf(state);
  const b = coach.branch;
  if (!b) return state;
  const history = [...coach.history, { title: b.title, returnStepId: b.fromStepId, outcome: 'cancelled' as const }].slice(-MAX_HISTORY);
  const next = withCoach(state, { ...coach, branch: null, history });
  return b.status === 'active' ? setCursor(def, next, stepIndex(def, b.fromStepId)) : next;
}

/** Previous/Next inside an active fix. Past the last fix step, it returns to the original guide. */
export function stepBranch(def: AppletDefinition, state: AppletState, by: 1 | -1): AppletState {
  const coach = coachOf(state);
  const b = coach.branch;
  if (!b || b.status !== 'active') return state;
  const index = b.index + by;
  if (index < 0) return state;
  if (index < b.steps.length) return withCoach(state, { ...coach, branch: { ...b, index } });
  const history = [...coach.history, { title: b.title, returnStepId: b.returnStepId, outcome: 'returned' as const }].slice(-MAX_HISTORY);
  return setCursor(def, withCoach(state, { ...coach, branch: null, history }), stepIndex(def, b.returnStepId));
}

/** Prefer this over the plain sequence step when a fix is active. */
export function coachStep(def: AppletDefinition, state: AppletState, by: 1 | -1): AppletState {
  if (coachOf(state).branch?.status === 'active') return stepBranch(def, state, by);
  const cur = currentStep(def, state);
  return cur ? setCursor(def, state, cur.index + by) : state;
}
