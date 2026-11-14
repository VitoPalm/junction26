import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithoutDatabase } from '@junction26/db/testing';
import { claimJob, getJobById } from '@junction26/db';
import { createHarness, type Harness } from './test-support/harness.ts';

const ALICE = 'dev:alice';
const BOB = 'dev:bob';
const definition = { formatVersion: 1, title: 'Row counter', state: { rows: { type: 'number', default: 0 } } };

describe('api', { skip: skipWithoutDatabase }, () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => h?.close());

  async function newProject(token = ALICE, title = 'Crochet') {
    const r = await h.call('POST', '/v1/projects', { token, body: { title } });
    assert.equal(r.status, 201);
    return r.body.project.id as string;
  }

  async function pairDevice(token = ALICE) {
    const code = await h.call('POST', '/v1/devices/pairing-codes', { token });
    assert.equal(code.status, 201);
    assert.match(code.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const paired = await h.call('POST', '/v1/devices/pair', { body: { code: code.body.code.toLowerCase(), label: 'MRBD' } });
    assert.equal(paired.status, 201);
    return { token: paired.body.token as string, deviceId: paired.body.device.id as string, code: code.body.code as string };
  }

  test('health endpoints', async () => {
    assert.equal((await h.call('GET', '/healthz')).status, 200);
    const ready = await h.call('GET', '/readyz');
    assert.deepEqual(ready.body, { ok: true, checks: { database: 'ok', storage: 'ok' } });
  });

  test('authentication is required and errors are structured', async () => {
    const r = await h.call('GET', '/v1/projects');
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'unauthenticated');
    assert.equal((await h.call('GET', '/v1/projects', { token: 'dev:bad name' })).status, 401);
    assert.equal((await h.call('GET', '/v1/projects', { token: 'j26d_nope' })).status, 401);
    assert.ok(r.headers.get('x-request-id'));
  });

  test('ownership: other users see 404, never the resource', async () => {
    const id = await newProject();
    assert.equal((await h.call('GET', `/v1/projects/${id}`, { token: ALICE })).status, 200);
    for (const [method, path] of [
      ['GET', `/v1/projects/${id}`],
      ['GET', `/v1/projects/${id}/revisions`],
      ['GET', `/v1/projects/${id}/releases/latest`],
      ['GET', `/v1/projects/${id}/state`],
    ] as const) {
      const r = await h.call(method, path, { token: BOB });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
    const bobList = await h.call('GET', '/v1/projects', { token: BOB });
    assert.deepEqual(bobList.body.projects, []);
    assert.equal((await h.call('POST', `/v1/projects/${id}/revisions`, { token: BOB, body: { definition } })).status, 404);
    assert.equal((await h.call('GET', '/v1/projects/not-a-uuid', { token: ALICE })).status, 404);
  });

  test('request validation lists every issue', async () => {
    const r = await h.call('POST', '/v1/projects', { token: ALICE, body: { title: '' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'invalid_request');
    assert.equal(r.body.error.details[0].path, 'title');
    const bad = await h.call('POST', '/v1/projects', { token: ALICE, body: 'not json', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400);
  });

  test('revisions: invalid definitions are rejected with issues; valid ones are numbered', async () => {
    const id = await newProject();
    const bad = await h.call('POST', `/v1/projects/${id}/revisions`, { token: ALICE, body: { definition: { title: 'x' } } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.details.issues[0].path, '$.formatVersion');
    const r1 = await h.call('POST', `/v1/projects/${id}/revisions`, { token: ALICE, body: { definition } });
    const r2 = await h.call('POST', `/v1/projects/${id}/revisions`, {
      token: ALICE,
      body: { definition: { ...definition, title: 'v2' }, baseRevisionId: r1.body.revision.id },
    });
    assert.deepEqual([r1.body.revision.number, r2.body.revision.number], [1, 2]);
    const got = await h.call('GET', `/v1/projects/${id}/revisions/${r2.body.revision.id}`, { token: ALICE });
    assert.equal(got.body.revision.definition.title, 'v2');
    const list = await h.call('GET', `/v1/projects/${id}/revisions`, { token: ALICE });
    assert.equal(list.body.revisions.length, 2);
    assert.equal(list.body.revisions[0].definition, undefined);
  });

  test('messages queue one generation job per idempotency key', async () => {
    const id = await newProject();
    const send = (text: string, key = 'msg-key-0001') =>
      h.call('POST', `/v1/projects/${id}/messages`, { token: ALICE, body: { text }, headers: { 'idempotency-key': key } });
    const first = await send('Make me a row counter');
    assert.equal(first.status, 202);
    assert.equal(first.body.job.kind, 'generate_revision');
    assert.equal(first.body.job.status, 'queued');
    const retry = await send('Make me a row counter');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.job.id, first.body.job.id);
    assert.equal(retry.body.message.id, first.body.message.id);
    const reused = await send('Something else');
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, 'idempotency_key_reused');
    const msgs = await h.call('GET', `/v1/projects/${id}/messages`, { token: ALICE });
    assert.equal(msgs.body.messages.length, 1);

    const job = await h.call('GET', `/v1/jobs/${first.body.job.id}`, { token: ALICE });
    assert.equal(job.body.job.id, first.body.job.id);
    assert.equal(job.body.job.leaseOwner, undefined);
    assert.equal((await h.call('GET', `/v1/jobs/${first.body.job.id}`, { token: BOB })).status, 404);
    const cancelled = await h.call('POST', `/v1/jobs/${first.body.job.id}/cancel`, { token: ALICE });
    assert.equal(cancelled.body.job.status, 'cancelled');
  });

  test('uploads stream to storage with size, type and content checks', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n' + 'x'.repeat(100));
    const ok = await h.call('POST', '/v1/uploads?filename=manual.pdf', { token: ALICE, body: pdf, headers: { 'content-type': 'application/pdf' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.upload.status, 'stored');
    assert.equal(ok.body.upload.byteSize, pdf.length);
    assert.match(ok.body.upload.sha256, /^[0-9a-f]{64}$/);
    assert.equal(ok.body.job.kind, 'prepare_upload');
    assert.equal(ok.body.upload.objectKey, undefined);
    assert.equal(h.store.objects.size, 1);

    const wrongType = await h.call('POST', '/v1/uploads', { token: ALICE, body: pdf, headers: { 'content-type': 'application/zip' } });
    assert.equal(wrongType.status, 415);
    const mismatch = await h.call('POST', '/v1/uploads', {
      token: ALICE,
      body: new TextEncoder().encode('not really a png file at all'),
      headers: { 'content-type': 'image/png' },
    });
    assert.equal(mismatch.status, 415);
    assert.equal(mismatch.body.error.code, 'content_mismatch');
    assert.equal(h.store.objects.size, 1, 'rejected uploads leave no object');
  });

  test('uploads over the limit are refused while streaming', async () => {
    const small = await createHarness({ MAX_UPLOAD_BYTES: '64' });
    try {
      const body = new TextEncoder().encode('hello '.repeat(50));
      // No Content-Length: the limit must be enforced on the stream itself.
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(body.subarray(0, 40));
          c.enqueue(body.subarray(40));
          c.close();
        },
      });
      const res = await small.app.request('/v1/uploads', {
        method: 'POST',
        headers: { authorization: `Bearer ${ALICE}`, 'content-type': 'text/plain' },
        body: stream,
        duplex: 'half',
      } as RequestInit);
      assert.equal(res.status, 413);
      assert.equal(small.store.objects.size, 0);
      const { rows } = await small.db.pool.query(`SELECT status FROM uploads`);
      assert.deepEqual(rows, [{ status: 'rejected' }]);
    } finally {
      await small.close();
    }
  });

  test('device pairing: one-use codes, scoped sessions, revocation', async () => {
    const device = await pairDevice();
    const reuse = await h.call('POST', '/v1/devices/pair', { body: { code: device.code } });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error.code, 'invalid_pairing_code');

    const me = await h.call('GET', '/v1/me', { token: device.token });
    assert.equal(me.body.principal.kind, 'device');
    assert.equal((await h.call('GET', '/v1/projects', { token: device.token })).status, 200);
    // Devices can't author.
    assert.equal((await h.call('POST', '/v1/projects', { token: device.token, body: { title: 'x' } })).status, 403);
    assert.equal((await h.call('POST', '/v1/devices/pairing-codes', { token: device.token })).status, 403);

    const list = await h.call('GET', '/v1/devices', { token: ALICE });
    assert.ok(list.body.devices.some((d: { id: string }) => d.id === device.deviceId));
    assert.equal((await h.call('DELETE', `/v1/devices/${device.deviceId}`, { token: BOB })).status, 404);
    assert.equal((await h.call('DELETE', `/v1/devices/${device.deviceId}`, { token: ALICE })).status, 200);
    assert.equal((await h.call('GET', '/v1/projects', { token: device.token })).status, 401);
  });

  test('expired pairing codes are refused', async () => {
    const code = await h.call('POST', '/v1/devices/pairing-codes', { token: ALICE });
    await h.db.pool.query(`UPDATE pairing_codes SET expires_at = now() - interval '1 second'`);
    const r = await h.call('POST', '/v1/devices/pair', { body: { code: code.body.code } });
    assert.equal(r.status, 400);
  });

  test('state backup: device-only writes, idempotent, conflicts keep both', async () => {
    const id = await newProject();
    const a = await pairDevice();
    const b = await pairDevice();
    const put = (token: string, operationId: string, sequence: number, expectedServerVersion: number, snapshot: object = { rows: sequence }) =>
      h.call('PUT', `/v1/projects/${id}/state`, {
        token,
        body: { operationId, sequence, revisionId: null, schemaVersion: 1, expectedServerVersion, snapshot },
      });

    assert.equal((await put(ALICE, 'op0', 1, 0)).status, 403, 'authoring sessions never write live state');
    assert.equal((await h.call('GET', `/v1/projects/${id}/state`, { token: ALICE })).body.error.code, 'no_state');

    const first = await put(a.token, 'op1', 1, 0);
    assert.deepEqual(first.body, { outcome: 'accepted', serverVersion: 1, replayed: false });
    assert.equal((await put(a.token, 'op1', 1, 0)).body.replayed, true);
    const conflict = await put(b.token, 'op2', 1, 0, { rows: 99 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'state_conflict');
    assert.equal(conflict.body.error.details.current.serverVersion, 1);

    const got = await h.call('GET', `/v1/projects/${id}/state`, { token: ALICE });
    assert.deepEqual(got.body.snapshot, { rows: 1 });
    assert.equal(got.body.deviceId, a.deviceId);
  });

  test('publish: preconditions, idempotency, and packaging handoff', async () => {
    const id = await newProject();
    const rev = (await h.call('POST', `/v1/projects/${id}/revisions`, { token: ALICE, body: { definition } })).body.revision.id;
    const publish = (key: string | null, body: object) =>
      h.call('POST', `/v1/projects/${id}/releases`, { token: ALICE, body, headers: key ? { 'idempotency-key': key } : {} });

    assert.equal((await publish(null, { revisionId: rev, expectedCurrentReleaseId: null })).status, 400, 'key required');
    const wrongBase = await publish('pub-key-0001', { revisionId: rev, expectedCurrentReleaseId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(wrongBase.status, 409);
    assert.equal(wrongBase.body.error.code, 'release_precondition_failed');

    const queued = await publish('pub-key-0002', { revisionId: rev, expectedCurrentReleaseId: null });
    assert.equal(queued.status, 202);
    assert.equal(queued.body.release.status, 'pending');
    assert.equal(queued.body.release.packageUrl, null);
    const again = await publish('pub-key-0002', { revisionId: rev, expectedCurrentReleaseId: null });
    assert.equal(again.status, 200);
    assert.equal(again.body.release.id, queued.body.release.id);

    // Nothing is live until the worker packages it.
    assert.equal((await h.call('GET', `/v1/projects/${id}/releases/latest`, { token: ALICE })).body.error.code, 'no_release');
    assert.equal((await h.call('GET', `/v1/releases/${queued.body.release.id}/package`, { token: ALICE })).status, 404);

    const job = await getJobById(h.db.pool, queued.body.job.id);
    assert.equal(job?.kind, 'package_release');
    assert.deepEqual(job?.input.releaseId, queued.body.release.id);
    // Leave the job for nobody: claim it so later tests in this DB don't see it.
    await claimJob(h.db.pool, 'test', 60_000, ['package_release']);
  });
});
