import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDefinition, bookcaseGuide } from '@junction26/applet-format';
import {
  answerLocally, applyResult, cancelBranch, cancelRequest, checkAnswer, checkRecovery, coachContext, coachOf, coachStep,
  completeCurrent, confirmBranch, currentStep, initialState, isSafetyCritical, migrateState, NOT_ESTABLISHED, pendingRequest,
  retrieve, startRequest, passages, type AppletState,
} from './index.ts';

const v = validateDefinition(bookcaseGuide);
assert.ok(v.ok);
const def = v.definition;
const at = (i: number): AppletState => ({ ...initialState(def), values: { step: i } });

test('complete marks the step done, advances, and finishes on the last step', () => {
  let s = completeCurrent(def, at(0));
  assert.deepEqual(coachOf(s).completed, ['check_parts']);
  assert.equal(currentStep(def, s)!.index, 1);
  s = completeCurrent(def, at(8));
  assert.equal(coachOf(s).finished, true);
  assert.equal(currentStep(def, s)!.index, 8);
  // Completing twice doesn't duplicate.
  assert.deepEqual(coachOf(completeCurrent(def, { ...s, values: { step: 8 } })).completed, ['wall_fix']);
});

test('local answers cover parts, progress, warnings and repeat, with sources', () => {
  const parts = answerLocally(def, at(1), 'Which screw do I use?')!;
  assert.equal(parts.status, 'answered');
  assert.match(parts.text, /4 × Cam bolt \(A\) \(34 mm, silver\)/);
  assert.deepEqual(parts.sources[0], { page: 2, section: 'Step 2' });
  assert.match(answerLocally(def, at(3), 'how many steps are left')!.text, /^Step 4 of 9/);
  assert.equal(answerLocally(def, at(6), 'anything I should be careful about?')!.text, 'The back panel keeps it square. Never skip it.');
  assert.match(answerLocally(def, at(7), 'repeat that')!.text, /Note: Nail spacing figure is unreadable\./);
  assert.equal(answerLocally(def, at(2), 'can I use glue instead of dowels?'), null, 'inference goes to the backend');
});

test('requests are recorded once and results apply once', () => {
  let s = startRequest(at(4), { id: 'op1', kind: 'question', text: 'how tight?', stepId: 'cam_locks', createdAt: 't' });
  assert.equal(startRequest(s, { id: 'op1', kind: 'question', text: 'how tight?', stepId: 'cam_locks', createdAt: 't' }), s);
  assert.equal(pendingRequest(s)!.id, 'op1');
  const answer = { status: 'answered' as const, text: 'Half a turn clockwise.', sources: [{ page: 3 }], options: [] };
  s = applyResult(def, s, 'op1', { kind: 'question', answer });
  assert.equal(coachOf(s).answer!.text, 'Half a turn clockwise.');
  assert.equal(applyResult(def, s, 'op1', { kind: 'question', answer: { ...answer, text: 'again' } }), s, 'second delivery is ignored');
  const c = cancelRequest(startRequest(s, { id: 'op2', kind: 'question', text: 'x', stepId: 'cam_locks', createdAt: 't' }), 'op2');
  assert.equal(applyResult(def, c, 'op2', { kind: 'question', answer }), c, 'cancelled requests ignore late results');
});

test('a recovery branch needs confirmation, keeps progress and returns to the guide', () => {
  let s = completeCurrent(def, completeCurrent(def, completeCurrent(def, at(0))));
  s = completeCurrent(def, s); // now on step 5 (cam_locks), 4 done
  s = startRequest(s, { id: 'p1', kind: 'problem', text: 'I put the left side on backwards', stepId: 'cam_locks', createdAt: 't' });
  const recovery = { status: 'proposal' as const, title: 'Refit left side', rationale: 'Bolts must face the shelves.', returnStepId: 'left_side', sources: [{ page: 3 }],
    steps: [{ text: 'Take the left side off.', source: { page: 3 } }, { text: 'Turn it around.', source: { page: 3 } }] };
  s = applyResult(def, s, 'p1', { kind: 'problem', recovery });
  assert.equal(coachOf(s).branch!.status, 'proposed');
  assert.equal(coachStep(def, s, 1).values.step, 5, 'unconfirmed proposal does not take over navigation');
  s = confirmBranch(s);
  assert.equal(coachOf(s).branch!.status, 'active');
  // A second proposal can't replace the active fix.
  s = startRequest(s, { id: 'p2', kind: 'problem', text: 'other', stepId: 'cam_locks', createdAt: 't' });
  s = applyResult(def, s, 'p2', { kind: 'problem', recovery: { ...recovery, title: 'Other' } });
  assert.equal(coachOf(s).branch!.title, 'Refit left side');
  s = coachStep(def, s, 1);
  assert.equal(coachOf(s).branch!.index, 1);
  s = coachStep(def, s, 1);
  assert.equal(coachOf(s).branch, null);
  assert.equal(currentStep(def, s)!.step.id, 'left_side');
  assert.deepEqual(coachOf(s).completed, ['check_parts', 'cam_bolts', 'dowels', 'left_side']);
  assert.equal(coachOf(s).history.at(-1)!.outcome, 'returned');
});

test('cancelling an active fix returns to where the problem was reported', () => {
  let s = startRequest(at(4), { id: 'p1', kind: 'problem', text: 'backwards', stepId: 'cam_locks', createdAt: 't' });
  s = applyResult(def, s, 'p1', { kind: 'problem', recovery: { status: 'proposal', title: 'T', rationale: '', returnStepId: 'left_side', sources: [], steps: [{ text: 'x', source: null }] } });
  s = coachStep(def, confirmBranch(s), 1); // finishes the one-step fix → back on left_side
  assert.equal(currentStep(def, s)!.step.id, 'left_side');
  s = startRequest(at(4), { id: 'p3', kind: 'problem', text: 'b', stepId: 'cam_locks', createdAt: 't' });
  s = applyResult(def, s, 'p3', { kind: 'problem', recovery: { status: 'proposal', title: 'T', rationale: '', returnStepId: 'left_side', sources: [], steps: [{ text: 'x', source: null }, { text: 'y', source: null }] } });
  s = cancelBranch(def, confirmBranch(s));
  assert.equal(coachOf(s).branch, null);
  assert.equal(currentStep(def, s)!.step.id, 'cam_locks');
});

test('model answers must cite given passages; otherwise "not established"', () => {
  const given = retrieve(def, 'how tight should the cam lock be', 'cam_locks');
  assert.ok(given.length);
  const ok = checkAnswer({ status: 'answered', answer: 'Half a turn clockwise until it pulls tight.', sourceIds: [given[0]!.id] }, given);
  assert.equal(ok.status, 'answered');
  assert.equal(checkAnswer({ status: 'answered', answer: 'Use 5 Nm.', sourceIds: [] }, given).text, NOT_ESTABLISHED);
  assert.equal(checkAnswer({ status: 'answered', answer: 'x', sourceIds: ['e999'] }, given).status, 'insufficient');
});

test('recovery proposals are checked against the manual and fail closed', () => {
  const given = passages(def);
  const good = checkRecovery(def, { status: 'proposal', title: 'Refit', returnStepId: 'left_side', steps: [{ text: 'Refit as in step 4.', sourceId: 's3' }] }, given, 'cam_locks');
  assert.equal(good.status, 'proposal');
  assert.equal(checkRecovery(def, { status: 'proposal', returnStepId: 'wall_fix', steps: [{ text: 'x', sourceId: 's3' }] }, given, 'cam_locks').status, 'unsupported', 'cannot jump ahead');
  assert.equal(checkRecovery(def, { status: 'proposal', returnStepId: 'left_side', steps: [{ text: 'x', sourceId: 'made_up' }] }, given, 'cam_locks').status, 'unsupported');
  assert.ok(isSafetyCritical('the shelf cracked'));
  assert.ok(!isSafetyCritical('I attached this backwards'));
});

test('read-only context and migration keep coach data', () => {
  const s = completeCurrent(def, at(0));
  const ctx = coachContext(def, s)!;
  assert.equal(ctx.step.number, 2);
  assert.equal(ctx.parts[0]!.label, 'Cam bolt (A)');
  assert.equal(ctx.progress.completed, 1);
  assert.deepEqual(migrateState(def, s, 'r2').coach, s.coach);
});
