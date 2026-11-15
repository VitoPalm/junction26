import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithoutDatabase } from '@junction26/db/testing';
import { createHarness, type Harness } from './test-support/harness.ts';

/**
 * Demo budget (docs/api.md, "Demo budget") on a real database. No worker runs,
 * so queued paid generations stay reserved at their estimate ($0.03 each).
 */
describe('demo budget', { skip: skipWithoutDatabase }, () => {
  let h: Harness;
  const T = 'dev:budget-owner';
  const VIP = 'dev:budget-vip';

  before(async () => {
    h = await createHarness({
      AUTHORING_MODEL: 'openai/paid-model',
      AUTHORING_MODELS: 'fake:demo',
      USER_BUDGET_USD: '0.05',
      BUDGET_EXEMPT_USERS: VIP,
    });
  });
  after(async () => {
    await h?.close();
  });

  const project = async (token: string) => (await h.call('POST', '/v1/projects', { token, body: { title: 'Budget' } })).body.project.id as string;
  const generate = (token: string, projectId: string, model?: string) =>
    h.call('POST', `/v1/projects/${projectId}/messages`, { token, body: { text: 'Make a counter', ...(model ? { model } : {}) } });

  test('paid work is refused with 402 once the cap is reached; fake models stay free', async () => {
    const p = await project(T);
    let usage = await h.call('GET', '/v1/usage', { token: T });
    assert.deepEqual(usage.body.usage, { budgetUsd: 0.05, spentUsd: 0, remainingUsd: 0.05, exempt: false });

    assert.equal((await generate(T, p)).status, 202);
    assert.equal((await generate(T, p)).status, 202, '0.03 spent < 0.05: still allowed');
    const refused = await generate(T, p);
    assert.equal(refused.status, 402, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, 'budget_exhausted');

    usage = await h.call('GET', '/v1/usage', { token: T });
    assert.equal(usage.body.usage.spentUsd, 0.06);
    assert.equal(usage.body.usage.remainingUsd, 0);

    assert.equal((await generate(T, p, 'fake:demo')).status, 202, 'fake models never count or block');
  });

  test('recorded job cost replaces the estimate', async () => {
    const owner = 'dev:budget-recorded';
    const p = await project(owner);
    const res = await generate(owner, p);
    await h.db.pool.query(`UPDATE jobs SET status = 'succeeded', finished_at = now(), usage = '{"costUsd": 0.004}' WHERE id = $1`, [res.body.job.id]);
    const usage = await h.call('GET', '/v1/usage', { token: owner });
    assert.equal(usage.body.usage.spentUsd, 0.004);
  });

  test('API-side model calls count through the ledger', async () => {
    const owner = 'dev:budget-ledger';
    await project(owner);
    const { rows } = await h.db.pool.query(`SELECT id FROM users WHERE external_id = $1`, [owner]);
    await h.db.pool.query(`INSERT INTO model_usage (owner_id, source, model, cost_usd) VALUES ($1, 'voice_bridge', 'openrouter:x', 0.05)`, [rows[0].id]);
    const usage = await h.call('GET', '/v1/usage', { token: owner });
    assert.equal(usage.body.usage.remainingUsd, 0);
  });

  test('browser voice preview is refused before any model call once the cap is reached', async () => {
    // 'dev:budget-ledger' hit the cap in the previous test; VOICE_MODEL is a paid default with no key.
    const res = await h.call('POST', '/v1/voice/resolve', {
      token: 'dev:budget-ledger',
      body: { context: { projectId: 'p1', title: 'Counter', view: null, tools: [{ name: 'add', description: 'Add', parameters: { type: 'object', properties: {} } }], state: '{}' }, text: 'add one' },
    });
    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'budget_exhausted');
  });

  test('exempt users have no cap', async () => {
    const p = await project(VIP);
    for (let i = 0; i < 3; i++) assert.equal((await generate(VIP, p)).status, 202);
    const usage = await h.call('GET', '/v1/usage', { token: VIP });
    assert.equal(usage.body.usage.budgetUsd, null);
    assert.equal(usage.body.usage.exempt, true);
  });
});
