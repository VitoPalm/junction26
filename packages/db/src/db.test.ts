import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from './testing.ts';
import {
  claimJob,
  completeJob,
  createProject,
  createRevision,
  enqueueJob,
  failExhaustedJobs,
  failJob,
  getJobById,
  heartbeatJob,
  markJobCancelled,
  migrate,
  MIGRATIONS_DIR,
  putStateBackup,
  getCurrentState,
  releaseWorkerLeases,
  requestJobCancel,
  upsertUserByExternalId,
  createDevice,
  getProject,
  withTransaction,
} from './index.ts';

describe('database', { skip: skipWithoutDatabase }, () => {
  let db: TestDatabase;
  let userId: string;
  let projectId: string;

  before(async () => {
    db = await createTestDatabase();
    userId = (await upsertUserByExternalId(db.pool, 'dev:alice')).id;
    projectId = (await createProject(db.pool, userId, 'Row counter')).id;
  });
  after(async () => db?.drop());

  test('migrations are idempotent and refuse edited files', async () => {
    const again = await migrate(db.pool);
    assert.deepEqual(again.applied, []);
    assert.ok(again.alreadyApplied.includes('0001_initial.sql'));

    const dir = await mkdtemp(join(tmpdir(), 'j26-mig-'));
    try {
      await cp(MIGRATIONS_DIR, dir, { recursive: true });
      await writeFile(join(dir, '0001_initial.sql'), '-- edited\n');
      await assert.rejects(migrate(db.pool, dir), /changed after it was applied/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('revision numbers increase per project', async () => {
    const make = () =>
      withTransaction(db.pool, async (c) => {
        await getProject(c, userId, projectId, { forUpdate: true });
        return createRevision(c, {
          projectId,
          baseRevisionId: null,
          definition: { formatVersion: 1, title: 'x' },
          formatVersion: 1,
          minimumRuntimeVersion: null,
          validationStatus: 'valid',
          validationIssues: [],
          source: 'client',
        });
      });
    const nums = (await Promise.all([make(), make(), make()])).map((r) => r.number).sort();
    assert.deepEqual(nums, [1, 2, 3]);
  });

  describe('jobs', () => {
    const lease = 60_000;

    test('idempotency key returns the existing job', async () => {
      const a = await enqueueJob(db.pool, { ownerId: userId, projectId, kind: 'generate_revision', input: { n: 1 }, idempotencyKey: 'k1' });
      const b = await enqueueJob(db.pool, { ownerId: userId, projectId, kind: 'generate_revision', input: { n: 2 }, idempotencyKey: 'k1' });
      assert.equal(a.created, true);
      assert.equal(b.created, false);
      assert.equal(b.job.id, a.job.id);
      assert.deepEqual(b.job.input, { n: 1 });
      await requestJobCancel(db.pool, userId, a.job.id);
    });

    test('concurrent claims never return the same job', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 5; i++) {
        ids.add((await enqueueJob(db.pool, { ownerId: userId, projectId, kind: 'prepare_upload', input: { i } })).job.id);
      }
      const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claimJob(db.pool, `w${i}`, lease, ['prepare_upload'])));
      const claimed = claims.filter((j) => j !== null).map((j) => j.id);
      assert.equal(claimed.length, 5);
      assert.equal(new Set(claimed).size, 5);
      for (const j of claims) if (j) assert.ok(await completeJob(db.pool, j.id, j.leaseOwner!, { ok: true }));
    });

    test('expired lease is recovered by another worker; the old worker is fenced out', async () => {
      const { job } = await enqueueJob(db.pool, { ownerId: userId, projectId, kind: 'package_release', input: {}, maxAttempts: 2 });
      const first = await claimJob(db.pool, 'crashed', 1, ['package_release']);
      assert.equal(first?.id, job.id);
      await new Promise((r) => setTimeout(r, 20));
      const second = await claimJob(db.pool, 'rescuer', lease, ['package_release']);
      assert.equal(second?.id, job.id);
      assert.equal(second?.attempts, 2);
      // The crashed worker comes back and can't touch the job.
      assert.deepEqual(await heartbeatJob(db.pool, job.id, 'crashed', lease), { held: false, cancelRequested: false });
      assert.equal(await completeJob(db.pool, job.id, 'crashed', { wrong: true }), false);
      assert.equal(await completeJob(db.pool, job.id, 'rescuer', { right: true }), true);
      assert.deepEqual((await getJobById(db.pool, job.id))?.result, { right: true });
    });

    test('lease expiring on the last attempt fails the job', async () => {
      const { job } = await enqueueJob(db.pool, { ownerId: userId, projectId, kind: 'package_release', input: {}, maxAttempts: 1 });
      await claimJob(db.pool, 'crashed', 1, ['package_release']);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(await claimJob(db.pool, 'other', lease, ['package_release']), null);
      assert.equal(await failExhaustedJobs(db.pool), 1);
      const after = await getJobById(db.pool, job.id);
      assert.equal(after?.status, 'failed');
      assert.equal(after?.error?.code, 'lease_expired');
    });

    test('retryable failure requeues with delay until attempts run out', async () => {
      const { job } = await enqueueJob(db.pool, { ownerId: userId, projectId, kind: 'prepare_upload', input: {}, maxAttempts: 2 });
      await claimJob(db.pool, 'w', lease, ['prepare_upload']);
      assert.equal(await failJob(db.pool, job.id, 'w', { code: 'x', message: 'boom' }, 0), 'retrying');
      const again = await claimJob(db.pool, 'w', lease, ['prepare_upload']);
      assert.equal(again?.id, job.id);
      assert.equal(await failJob(db.pool, job.id, 'w', { code: 'x', message: 'boom' }, 0), 'failed');
      assert.equal((await getJobById(db.pool, job.id))?.status, 'failed');
    });

    test('future run_after is not claimable', async () => {
      const { job } = await enqueueJob(db.pool, { ownerId: userId, projectId, kind: 'prepare_upload', input: {}, maxAttempts: 2 });
      await claimJob(db.pool, 'w', lease, ['prepare_upload']);
      await failJob(db.pool, job.id, 'w', { code: 'x', message: 'later' }, 60_000);
      assert.equal(await claimJob(db.pool, 'w', lease, ['prepare_upload']), null);
      await requestJobCancel(db.pool, userId, job.id);
    });

    test('cancel: queued is immediate, running is flagged for the heartbeat', async () => {
      const q = (await enqueueJob(db.pool, { ownerId: userId, projectId, kind: 'generate_revision', input: {} })).job;
      assert.equal((await requestJobCancel(db.pool, userId, q.id))?.status, 'cancelled');
      assert.equal(await requestJobCancel(db.pool, 'ffffffff-ffff-ffff-ffff-ffffffffffff', q.id), null);

      const r = (await enqueueJob(db.pool, { ownerId: userId, projectId, kind: 'generate_revision', input: {} })).job;
      await claimJob(db.pool, 'w', lease, ['generate_revision']);
      assert.equal((await requestJobCancel(db.pool, userId, r.id))?.status, 'running');
      assert.deepEqual(await heartbeatJob(db.pool, r.id, 'w', lease, { step: 'x' }), { held: true, cancelRequested: true });
      assert.ok(await markJobCancelled(db.pool, r.id, 'w'));
      assert.equal((await getJobById(db.pool, r.id))?.status, 'cancelled');
    });

    test('releasing leases on shutdown requeues without counting the attempt', async () => {
      const { job } = await enqueueJob(db.pool, { ownerId: userId, projectId, kind: 'prepare_upload', input: {} });
      await claimJob(db.pool, 'leaving', lease, ['prepare_upload']);
      assert.equal(await releaseWorkerLeases(db.pool, 'leaving'), 1);
      const after = await getJobById(db.pool, job.id);
      assert.equal(after?.status, 'queued');
      assert.equal(after?.attempts, 0);
      await requestJobCancel(db.pool, userId, job.id);
    });
  });

  describe('state backups', () => {
    let deviceA: string;
    let deviceB: string;
    let pid: string;
    before(async () => {
      pid = (await createProject(db.pool, userId, 'State test')).id;
      deviceA = (await createDevice(db.pool, userId, 'A', 'hash-a')).id;
      deviceB = (await createDevice(db.pool, userId, 'B', 'hash-b')).id;
    });
    const put = (deviceId: string, operationId: string, sequence: number, expected: number, snapshot: unknown = { n: sequence }) =>
      putStateBackup(db.pool, {
        projectId: pid,
        deviceId,
        operationId,
        sequence,
        revisionId: null,
        schemaVersion: 1,
        expectedServerVersion: expected,
        snapshot,
      });

    test('accepts in order, replays idempotently, rejects stale and conflicting writes', async () => {
      const first = await put(deviceA, 'op1', 1, 0);
      assert.equal(first.outcome, 'accepted');
      assert.equal(first.outcome === 'accepted' && first.serverVersion, 1);

      const replay = await put(deviceA, 'op1', 1, 0);
      assert.deepEqual(replay, { ...first, replayed: true });

      assert.equal((await put(deviceA, 'op2', 2, 1)).outcome, 'accepted');

      // Expected version is stale: someone else wrote in between.
      const conflict = await put(deviceB, 'op3', 1, 1, { mine: true });
      assert.equal(conflict.outcome, 'conflict');
      assert.deepEqual(conflict.outcome === 'conflict' && conflict.current, { serverVersion: 2, deviceId: deviceA, sequence: 2 });

      // Same device, matching version, but an older sequence.
      assert.equal((await put(deviceA, 'op4', 2, 2)).outcome, 'stale');

      const current = await getCurrentState(db.pool, pid);
      assert.equal(current?.serverVersion, 2);
      assert.deepEqual(current?.backup.snapshot, { n: 2 });

      // The conflicting snapshot is retained, not lost.
      const { rows } = await db.pool.query(`SELECT snapshot FROM state_backups WHERE operation_id = 'op3'`);
      assert.deepEqual(rows[0]?.snapshot, { mine: true });
    });
  });
});
