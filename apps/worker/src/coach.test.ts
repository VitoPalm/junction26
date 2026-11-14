import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookcaseGuide, validateDefinition } from '@junction26/applet-format';
import { createModelRegistry, FakeProvider } from '@junction26/model';
import type { Job } from '@junction26/db';
import { coachRequestHandler, fakeCoach, type CoachJobInput } from './coach.ts';
import type { JobContext, WorkerDeps } from './types.ts';

const def = (validateDefinition(bookcaseGuide) as { ok: true; definition: unknown }).definition;

function harness() {
  const fake = new FakeProvider((req) => fakeCoach(req));
  const models = createModelRegistry({ fake: (req, n) => fake.complete(req).then((r) => r.text) });
  const pool = { query: async () => ({ rows: [{ id: 'rev1', project_id: 'p1', definition: def }] }) };
  const deps = { pool, config: { coach: { model: 'fake:coach' } } } as unknown as WorkerDeps;
  const ctx = { deps, signal: new AbortController().signal, log: console, progress: async () => {} } as unknown as JobContext;
  const handler = coachRequestHandler(models);
  const run = async (input: Partial<CoachJobInput>) => {
    const job = { input: { projectId: 'p1', revisionId: 'rev1', stepId: 'cam_locks', kind: 'question', text: '', clarifications: [], ...input } } as unknown as Job;
    return (await handler.run(job, ctx)).result as any;
  };
  return { run, fake };
}

test('a question the manual answers comes back with a page citation', async () => {
  const { run } = harness();
  const r = await run({ text: 'How far do I turn the cam lock?' });
  assert.equal(r.answer.status, 'answered');
  assert.match(r.answer.text, /clockwise half a turn/i);
  assert.deepEqual(r.answer.sources, [{ page: 3, section: 'Step 5' }]);
});

test('a question the manual does not answer says so instead of guessing', async () => {
  const { run } = harness();
  const r = await run({ text: 'What wood glue brand should I buy?' });
  assert.equal(r.answer.status, 'insufficient');
  assert.match(r.answer.text, /manual doesn’t say/);
  assert.deepEqual(r.answer.sources, []);
});

test('a vague problem gets a clarifying question; the answer leads to a proposal', async () => {
  const { run } = harness();
  const first = await run({ kind: 'problem', text: 'something is wrong' });
  assert.equal(first.recovery.status, 'clarify');
  assert.deepEqual(first.recovery.options, ['Fitted it backwards', 'A part is missing', 'Something else']);
  const second = await run({ kind: 'problem', text: 'something is wrong', clarifications: ['Fitted it backwards'] });
  assert.equal(second.recovery.status, 'proposal');
  assert.equal(second.recovery.returnStepId, 'cam_locks');
});

test('"I attached the left side backwards" proposes redoing that step, with sources and a return point', async () => {
  const { run } = harness();
  const r = await run({ kind: 'problem', text: 'I attached the left side panel backwards' });
  assert.equal(r.recovery.status, 'proposal');
  assert.equal(r.recovery.returnStepId, 'left_side');
  assert.equal(r.recovery.steps.length, 3);
  for (const s of r.recovery.steps) assert.deepEqual(s.source, { page: 3, section: 'Step 4' });
});

test('safety-critical reports never reach the model', async () => {
  const { run, fake } = harness();
  const r = await run({ kind: 'problem', text: 'the shelf cracked when I pushed the dowel in' });
  assert.equal(r.recovery.status, 'unsupported');
  assert.match(r.recovery.message, /Stop here/);
  assert.equal(fake.calls.length, 0);
});

test('missing parts are sent back to the retailer, not improvised', async () => {
  const { run } = harness();
  const r = await run({ kind: 'problem', text: 'one cam lock is missing' });
  assert.equal(r.recovery.status, 'unsupported');
  assert.match(r.recovery.message, /retailer/);
});

test('model output with invented sources is refused', async () => {
  const models = createModelRegistry({ fake: () => JSON.stringify({ status: 'answered', answer: 'Use 5 Nm of torque.', sourceIds: ['e77'], options: [] }) });
  const pool = { query: async () => ({ rows: [{ id: 'rev1', project_id: 'p1', definition: def }] }) };
  const ctx = { deps: { pool, config: { coach: { model: 'fake:coach' } } }, signal: new AbortController().signal } as unknown as JobContext;
  const job = { input: { projectId: 'p1', revisionId: 'rev1', stepId: 'cam_locks', kind: 'question', text: 'how tight is the cam lock', clarifications: [] } } as unknown as Job;
  const r = (await coachRequestHandler(models).run(job, ctx)).result as any;
  assert.equal(r.answer.status, 'insufficient');
});
