import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithoutDatabase } from '@junction26/db/testing';
import { FIXTURES, bookcaseGuide } from '@junction26/applet-format';
import { JobRunner, createHandlers, modelRegistryFromConfig } from '@junction26/worker';
import { loadConfig, silentLogger } from '@junction26/server-common';
import { createHarness, type Harness } from './test-support/harness.ts';

/**
 * Task coach end to end on a real database (docs/task-coach.md): publish a
 * guide made from a manual, pair glasses, ask and report through
 * /v1/coach/requests, run the coach_request job with the free fake:coach
 * model, and read the result back. Covers idempotency, owner scoping and
 * refusals.
 */
describe('task coach requests', { skip: skipWithoutDatabase }, () => {
  let h: Harness;
  let runner: JobRunner;
  const T = 'dev:coach-owner';
  const OTHER = 'dev:coach-other';

  before(async () => {
    h = await createHarness({ AUTHORING_MODELS: 'fake:demo' });
    const config = loadConfig({ DATABASE_URL: h.db.url, SESSION_SECRET: 'x'.repeat(32), STORAGE_DRIVER: 'memory', AUTHORING_MODELS: 'fake:demo', COACH_MODEL: 'fake:coach' });
    runner = new JobRunner({ config, pool: h.db.pool, store: h.store, logger: silentLogger }, createHandlers(modelRegistryFromConfig(config)), {
      concurrency: 2, generationConcurrency: 1, pollMs: 50, leaseMs: 5000,
    });
  });
  after(async () => {
    await runner?.stop(100);
    await h?.close();
  });

  async function drain(jobId: string, token: string) {
    for (let i = 0; i < 100; i++) {
      await runner.tick();
      const r = await h.call('GET', `/v1/coach/requests/${jobId}`, { token });
      if (['succeeded', 'failed', 'cancelled'].includes(r.body.request.status)) return r.body.request;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('coach request did not finish');
  }

  async function publish(token: string, title: string, definition: unknown) {
    const projectId = (await h.call('POST', '/v1/projects', { token, body: { title } })).body.project.id;
    const revision = (await h.call('POST', `/v1/projects/${projectId}/revisions`, { token, body: { definition } })).body.revision;
    const pub = await h.call('POST', `/v1/projects/${projectId}/releases`, {
      token, body: { revisionId: revision.id, expectedCurrentReleaseId: null }, headers: { 'idempotency-key': `coach-${title}` },
    });
    for (let i = 0; i < 100; i++) {
      await runner.tick();
      const j = await h.call('GET', `/v1/jobs/${pub.body.job.id}`, { token });
      if (j.body.job.status === 'succeeded') return projectId as string;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('publish did not finish');
  }

  async function device(token: string) {
    const code = (await h.call('POST', '/v1/devices/pairing-codes', { token })).body.code;
    return (await h.call('POST', '/v1/devices/pair', { body: { code } })).body.token as string;
  }

  test('questions and problem reports run as idempotent, owner-scoped jobs with grounded results', async () => {
    const projectId = await publish(T, 'Bookcase', bookcaseGuide);
    const glasses = await device(T);
    const ask = (operationId: string, body: Record<string, unknown>, token = glasses) =>
      h.call('POST', '/v1/coach/requests', { token, body: { operationId, projectId, kind: 'question', stepId: 'cam_locks', text: 'How far do I turn the cam lock?', ...body } });

    const first = await ask('op-question-0001', {});
    assert.equal(first.status, 202);
    assert.equal(first.body.replayed, false);
    const again = await ask('op-question-0001', {});
    assert.equal(again.status, 200, 'resending the operation returns the same request');
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.request.id, first.body.request.id);

    const answered = await drain(first.body.request.id, glasses);
    assert.equal(answered.status, 'succeeded');
    assert.equal(answered.result.answer.status, 'answered');
    assert.match(answered.result.answer.text, /clockwise half a turn/i);
    assert.deepEqual(answered.result.answer.sources, [{ page: 3, section: 'Step 5' }]);
    assert.deepEqual(Object.keys(answered).sort(), ['error', 'id', 'result', 'status'], 'no usage or internals leak to the glasses');

    const unknown = await drain((await ask('op-question-0002', { text: 'What wood glue brand should I buy?' })).body.request.id, glasses);
    assert.equal(unknown.result.answer.status, 'insufficient');

    const report = await h.call('POST', '/v1/coach/requests', {
      token: glasses, body: { operationId: 'op-problem-0001', projectId, kind: 'problem', stepId: 'cam_locks', text: 'I attached the left side panel backwards' },
    });
    const fix = await drain(report.body.request.id, glasses);
    assert.equal(fix.result.recovery.status, 'proposal');
    assert.equal(fix.result.recovery.returnStepId, 'left_side');

    const safety = await h.call('POST', '/v1/coach/requests', {
      token: glasses, body: { operationId: 'op-problem-0002', projectId, kind: 'problem', stepId: 'dowels', text: 'the shelf cracked' },
    });
    assert.equal((await drain(safety.body.request.id, glasses)).result.recovery.status, 'unsupported');

    // Refusals and scoping.
    assert.equal((await ask('op-question-0003', { stepId: 'not_a_step' })).status, 422);
    assert.equal((await ask('op-question-0004', { text: '' })).status, 400);
    assert.equal((await ask('op-question-0005', {}, T)).status, 403, 'authoring sessions cannot use device endpoints');
    const stranger = await device(OTHER);
    assert.equal((await ask('op-question-0006', {}, stranger)).status, 404, 'another owner sees nothing');
    assert.equal((await h.call('GET', `/v1/coach/requests/${first.body.request.id}`, { token: stranger })).status, 404);

    // Cancel is best effort and owner-scoped.
    const pending = await ask('op-question-0007', { text: 'Which way does the arrow point?' });
    const cancelled = await h.call('POST', `/v1/coach/requests/${pending.body.request.id}/cancel`, { token: glasses });
    assert.equal(cancelled.status, 202);
    assert.equal(cancelled.body.request.status, 'cancelled');
  });

  test('requests need a published guide made from a manual', async () => {
    const glasses = await device(T);
    const pancakes = await publish(T, 'Pancakes', FIXTURES.pancakeGuide);
    const notGuide = await h.call('POST', '/v1/coach/requests', { token: glasses, body: { operationId: 'op-guide-0001', projectId: pancakes, kind: 'question', stepId: 'flour', text: 'how much?' } });
    assert.equal(notGuide.status, 409);
    assert.equal(notGuide.body.error.code, 'not_a_guide');
    const draft = (await h.call('POST', '/v1/projects', { token: T, body: { title: 'Draft' } })).body.project.id;
    const unpublished = await h.call('POST', '/v1/coach/requests', { token: glasses, body: { operationId: 'op-guide-0002', projectId: draft, kind: 'question', stepId: 'flour', text: 'how much?' } });
    assert.equal(unpublished.status, 409);
    assert.equal(unpublished.body.error.code, 'not_published');
  });
});
