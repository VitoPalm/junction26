import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithoutDatabase } from '@junction26/db/testing';
import { createHarness, type Harness } from './test-support/harness.ts';
import { clerkEnv, clerkToken } from './test-support/clerk.ts';

describe('Clerk API ownership and device pairing', { skip: skipWithoutDatabase }, () => {
  let h: Harness;
  before(async () => { h = await createHarness(clerkEnv); });
  after(async () => h?.close());
  test('verified users own projects and retain access across refreshed sessions', async () => {
    const alice = clerkToken();
    const created = await h.call('POST', '/v1/projects', { token: alice, body: { title: 'Clerk library' } });
    assert.equal(created.status, 201);
    const projectId = created.body.project.id;
    const refreshed = clerkToken({ sid: 'sess_another' });
    assert.equal((await h.call('GET', `/v1/projects/${projectId}`, { token: refreshed })).status, 200);
    const bob = clerkToken({ sub: 'user_bob' });
    assert.equal((await h.call('GET', `/v1/projects/${projectId}`, { token: bob })).status, 404);
    assert.deepEqual((await h.call('GET', '/v1/projects', { token: bob })).body.projects, []);
    assert.equal((await h.call('GET', '/v1/me', { token: 'dev:alice' })).status, 401);
    assert.equal((await h.call('GET', '/v1/me', { token: clerkToken({}, { typ: 'at+jwt' }) })).status, 401);

    const code = await h.call('POST', '/v1/devices/pairing-codes', { token: alice });
    assert.equal(code.status, 201);
    const pair = await h.call('POST', '/v1/devices/pair', { body: { code: code.body.code } });
    assert.equal(pair.status, 201);
    const device = pair.body.token;
    assert.equal((await h.call('GET', `/v1/projects/${projectId}`, { token: device })).status, 200);
    assert.equal((await h.call('POST', '/v1/projects', { token: device, body: { title: 'forbidden' } })).status, 403);
    assert.equal((await h.call('DELETE', `/v1/devices/${pair.body.device.id}`, { token: alice })).status, 200);
    assert.equal((await h.call('GET', '/v1/me', { token: device })).status, 401);
  });
});
