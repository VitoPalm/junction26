import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from '@junction26/db/testing';
import { claimJob, createProject, enqueueJob, getJobById, requestJobCancel, upsertUserByExternalId, type Job } from '@junction26/db';
import { loadConfig, silentLogger } from '@junction26/server-common';
import { MemoryObjectStore } from '@junction26/storage';
import { JobRunner } from './runner.ts';
import { JobError, type HandlerRegistry, type WorkerDeps } from './types.ts';

const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
};

describe('job runner', { skip: skipWithoutDatabase }, () => {
  let db: TestDatabase;
  let deps: WorkerDeps;
  let userId: string;
  let projectId: string;

  before(async () => {
    db = await createTestDatabase();
    const config = loadConfig({ DATABASE_URL: db.url, SESSION_SECRET: 'x'.repeat(32), STORAGE_DRIVER: 'memory' });
    deps = { config, pool: db.pool, store: new MemoryObjectStore(), logger: silentLogger };
    userId = (await upsertUserByExternalId(db.pool, 'dev:w')).id;
    projectId = (await createProject(db.pool, userId, 'p')).id;
  });
  after(async () => db?.drop());
  beforeEach(async () => {
    await db.pool.query('DELETE FROM jobs');
  });

  const runner = (handlers: HandlerRegistry, extra: Partial<ConstructorParameters<typeof JobRunner>[2]> = {}) =>
    new JobRunner(deps, handlers, { concurrency: 4, generationConcurrency: 1, pollMs: 20, leaseMs: 2000, retryDelayMs: () => 0, ...extra });
  const enqueue = async (kind: Job['kind'] = 'prepare_upload', maxAttempts = 3) =>
    (await enqueueJob(db.pool, { ownerId: userId, projectId, kind, input: {}, maxAttempts })).job.id;
  const status = async (id: string) => (await getJobById(db.pool, id))!;

  test('runs a job to success and records result, usage and progress', async () => {
    const r = runner({
      prepare_upload: {
        async run(_job, ctx) {
          await ctx.progress({ step: 'halfway' });
          return { result: { ok: 1 }, usage: { tokens: 5 } };
        },
      },
    });
    const id = await enqueue();
    await r.tick();
    await until(async () => (await status(id)).status === 'succeeded');
    const job = await status(id);
    assert.deepEqual([job.result, job.usage, job.progress], [{ ok: 1 }, { tokens: 5 }, { step: 'halfway' }]);
    await r.stop(100);
  });

  test('retryable errors retry until max attempts, then onFailed runs once', async () => {
    let calls = 0;
    let failedHook = 0;
    const r = runner({
      prepare_upload: {
        async run() {
          calls++;
          throw new JobError('flaky', 'try again', { retryable: true });
        },
        async onFailed() {
          failedHook++;
        },
      },
    });
    const id = await enqueue('prepare_upload', 3);
    for (let i = 0; i < 6; i++) {
      await r.tick();
      await new Promise((res) => setTimeout(res, 30));
    }
    await until(async () => (await status(id)).status === 'failed');
    assert.equal(calls, 3);
    assert.equal(failedHook, 1);
    assert.equal((await status(id)).error?.code, 'flaky');
    await r.stop(100);
  });

  test('non-retryable errors fail immediately', async () => {
    const r = runner({ prepare_upload: { run: async () => Promise.reject(new JobError('bad_input', 'no')) } });
    const id = await enqueue();
    await r.tick();
    await until(async () => (await status(id)).status === 'failed');
    assert.equal((await status(id)).attempts, 1);
    await r.stop(100);
  });

  test('cancellation reaches a running handler through its signal', async () => {
    let sawAbort = false;
    const r = runner(
      {
        generate_revision: {
          run: (_job, ctx) =>
            new Promise((_, reject) => {
              ctx.signal.addEventListener('abort', () => {
                sawAbort = true;
                reject(new Error('aborted'));
              });
            }),
        },
      },
      { leaseMs: 300 },
    );
    const id = await enqueue('generate_revision');
    await r.tick();
    await until(async () => (await status(id)).status === 'running');
    await requestJobCancel(db.pool, userId, id);
    await until(async () => (await status(id)).status === 'cancelled');
    assert.ok(sawAbort);
    await r.stop(100);
  });

  test('a job whose worker died is recovered after its lease expires', async () => {
    const id = await enqueue('package_release');
    await claimJob(db.pool, 'dead-worker', 50, ['package_release']);
    const r = runner({ package_release: { run: async () => ({ result: 'recovered' }) } });
    await new Promise((res) => setTimeout(res, 80));
    await r.tick();
    await until(async () => (await status(id)).status === 'succeeded');
    const job = await status(id);
    assert.equal(job.result, 'recovered');
    assert.equal(job.attempts, 2);
    await r.stop(100);
  });

  test('generation concurrency is capped separately', async () => {
    const release: (() => void)[] = [];
    const r = runner({ generate_revision: { run: () => new Promise((res) => release.push(() => res({ result: null }))) } });
    await enqueue('generate_revision');
    await enqueue('generate_revision');
    await r.tick();
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.activeCount, 1);
    release.shift()!();
    await until(async () => r.activeCount === 0);
    await r.tick();
    await until(async () => r.activeCount === 1);
    release.shift()!();
    await r.stop(1000);
  });

  test('shutdown hands unfinished jobs back to the queue without spending an attempt', async () => {
    const r = runner({ prepare_upload: { run: (_j, ctx) => new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('stop')))) } });
    const id = await enqueue();
    await r.tick();
    await until(async () => (await status(id)).status === 'running');
    await r.stop(50);
    const job = await status(id);
    assert.equal(job.status, 'queued');
    assert.equal(job.attempts, 0);
  });
});
