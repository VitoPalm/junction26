import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { skipWithoutDatabase } from '@junction26/db/testing';
import { JobRunner, createHandlers, modelRegistryFromConfig } from '@junction26/worker';
import { loadConfig, silentLogger } from '@junction26/server-common';
import { confirmAll, laundryDemo, parseLaundry, unconfirmedFields, type Garment } from '@junction26/laundry';
import { createHarness, type Harness } from './test-support/harness.ts';

/**
 * Laundry on a real database (docs/laundry.md): upload an original fixture
 * label photo, read it with the free fake:labels model, check every
 * instruction comes back unconfirmed with its source and a thumbnail, then
 * save and publish a confirmed laundry session for the glasses.
 */
const label = (file: string) => readFileSync(new URL(`../../../packages/laundry/src/fixtures/labels/${file}`, import.meta.url));

describe('laundry labels', { skip: skipWithoutDatabase }, () => {
  let h: Harness;
  let runner: JobRunner;
  const T = 'dev:laundry-owner';

  before(async () => {
    h = await createHarness({ AUTHORING_MODELS: 'fake:demo' });
    const config = loadConfig({ DATABASE_URL: h.db.url, SESSION_SECRET: 'x'.repeat(32), STORAGE_DRIVER: 'memory', AUTHORING_MODELS: 'fake:demo', LABEL_MODEL: 'fake:labels' });
    runner = new JobRunner({ config, pool: h.db.pool, store: h.store, logger: silentLogger }, createHandlers(modelRegistryFromConfig(config)), {
      concurrency: 2, generationConcurrency: 1, pollMs: 50, leaseMs: 5000,
    });
  });
  after(async () => {
    await runner?.stop(100);
    await h?.close();
  });

  async function drain(jobId: string) {
    for (let i = 0; i < 150; i++) {
      await runner.tick();
      const j = await h.call('GET', `/v1/jobs/${jobId}`, { token: T });
      if (['succeeded', 'failed', 'cancelled'].includes(j.body.job.status)) return j.body.job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('job did not finish');
  }

  async function read(projectId: string, file: string, bytes = label(file)) {
    const up = await h.call('POST', `/v1/uploads?projectId=${projectId}&filename=${file}`, { token: T, body: bytes, headers: { 'content-type': 'image/png' } });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    await drain(up.body.job.id);
    return { upload: up.body.upload, res: await h.call('POST', '/v1/laundry/labels', { token: T, body: { uploadId: up.body.upload.id } }) };
  }

  test('label photos are read into unconfirmed instructions with sources and a thumbnail', async () => {
    const projectId = (await h.call('POST', '/v1/projects', { token: T, body: { title: 'Laundry' } })).body.project.id;
    const { upload, res } = await read(projectId, 'blue-sweater.png');
    assert.equal(res.status, 202);
    const again = await h.call('POST', '/v1/laundry/labels', { token: T, body: { uploadId: upload.id } });
    assert.equal(again.body.job.id, res.body.job.id, 'one read per photo');
    const job = await drain(res.body.job.id);
    assert.equal(job.status, 'succeeded');
    const ex = job.result.extraction;
    assert.deepEqual(ex.label.wash.value, { method: 'hand', maxTempC: 30, cycle: null });
    assert.equal(ex.label.wash.source, 'Hand wash cold, max 30°C');
    assert.ok(Object.values(ex.label).every((f: any) => f.confirmed === false), 'nothing is confirmed by extraction');
    assert.deepEqual(ex.fibers, [{ fiber: 'wool', percent: 100 }]);
    assert.equal(job.result.thumbnail.mediaType, 'image/webp');
    assert.ok(Buffer.from(job.result.thumbnail.data, 'base64').length < 8000, 'thumbnail stays small for the glasses');

    const blurry = await drain((await read(projectId, 'linen-trousers.png')).res.body.job.id);
    assert.equal(blurry.result.extraction.label.wash.status, 'unreadable');
    assert.equal(blurry.result.extraction.needsClearerImage, true);

    // A photo the reader can't make out: everything unreadable, ask for a clearer one.
    const unknown = await drain((await read(projectId, 'kitchen.png', label('white-tee.png'))).res.body.job.id);
    assert.ok(Object.values(unknown.result.extraction.label).every((f: any) => f.status === 'unreadable'));
    assert.equal(unknown.result.extraction.needsClearerImage, true);

    const notImage = await h.call('POST', `/v1/uploads?projectId=${projectId}&filename=notes.txt`, { token: T, body: Buffer.from('hand wash'), headers: { 'content-type': 'text/plain' } });
    const refused = await h.call('POST', '/v1/laundry/labels', { token: T, body: { uploadId: notImage.body.upload.id } });
    assert.equal(refused.status, 422);
    assert.equal((await h.call('POST', '/v1/laundry/labels', { token: 'dev:someone-else', body: { uploadId: upload.id } })).status, 404, 'owner-scoped');
  });

  test('a confirmed session saves as a revision and publishes for the glasses', async () => {
    const projectId = (await h.call('POST', '/v1/projects', { token: T, body: { title: 'Laundry' } })).body.project.id;
    const parsed = parseLaundry(laundryDemo.task.data);
    assert.ok(parsed.ok);
    assert.ok(parsed.data.garments.every((g: Garment) => unconfirmedFields(confirmAll(g)).length === 0));
    const revision = (await h.call('POST', `/v1/projects/${projectId}/revisions`, { token: T, body: { definition: laundryDemo } })).body.revision;
    const pub = await h.call('POST', `/v1/projects/${projectId}/releases`, { token: T, body: { revisionId: revision.id, expectedCurrentReleaseId: null }, headers: { 'idempotency-key': 'laundry-publish' } });
    assert.equal((await drain(pub.body.job.id)).status, 'succeeded');
    const code = (await h.call('POST', '/v1/devices/pairing-codes', { token: T })).body.code;
    const device = (await h.call('POST', '/v1/devices/pair', { body: { code } })).body.token;
    const manifest = await h.call('GET', `/v1/projects/${projectId}/releases/latest`, { token: device });
    const pkg = (await (await h.app.request(manifest.body.release.packageUrl, { headers: { authorization: `Bearer ${device}` } })).json()) as { definition: { task: { kind: string; data: { garments: unknown[] } } } };
    assert.equal(pkg.definition.task.kind, 'laundry');
    assert.equal(pkg.definition.task.data.garments.length, parsed.data.garments.length);
  });
});
