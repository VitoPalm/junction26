import { FIXTURES, validateDefinition } from '@junction26/applet-format';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { skipWithoutDatabase } from '@junction26/db/testing';
import { JobRunner, createHandlers, modelRegistryFromConfig } from '@junction26/worker';
import { loadConfig, silentLogger } from '@junction26/server-common';
import { createHarness, type Harness } from './test-support/harness.ts';

/**
 * The smallest full backend flow (docs/backend-architecture.md, next work #7),
 * minus the model: author a definition -> publish -> worker packages ->
 * glasses sync manifest -> download package -> back up state -> restore.
 */
describe('end to end', { skip: skipWithoutDatabase }, () => {
  let h: Harness;
  let runner: JobRunner;
  const T = 'dev:e2e';

  before(async () => {
    h = await createHarness({ AUTHORING_MODELS: 'fake:demo' });
    const config = loadConfig({ DATABASE_URL: h.db.url, SESSION_SECRET: 'x'.repeat(32), STORAGE_DRIVER: 'memory', AUTHORING_MODELS: 'fake:demo' });
    runner = new JobRunner({ config, pool: h.db.pool, store: h.store, logger: silentLogger }, createHandlers(modelRegistryFromConfig(config)), {
      concurrency: 2,
      generationConcurrency: 1,
      pollMs: 50,
      leaseMs: 5000,
    });
  });
  after(async () => {
    await runner?.stop(100);
    await h?.close();
  });

  async function drain(jobId: string) {
    for (let i = 0; i < 100; i++) {
      await runner.tick();
      const j = await h.call('GET', `/v1/jobs/${jobId}`, { token: T });
      if (['succeeded', 'failed', 'cancelled'].includes(j.body.job.status)) return j.body.job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('job did not finish');
  }

  test('author -> publish -> sync -> download -> backup -> restore', async () => {
    const projectId = (await h.call('POST', '/v1/projects', { token: T, body: { title: 'Crochet' } })).body.project.id;
    const definition = { ...FIXTURES.rowCounter, title: 'Crochet' };
    const revision = (await h.call('POST', `/v1/projects/${projectId}/revisions`, { token: T, body: { definition } })).body.revision;

    const pub = await h.call('POST', `/v1/projects/${projectId}/releases`, {
      token: T,
      body: { revisionId: revision.id, expectedCurrentReleaseId: null },
      headers: { 'idempotency-key': 'e2e-publish-1' },
    });
    assert.equal(pub.status, 202);
    const job = await drain(pub.body.job.id);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.result.status, 'ready');

    // Glasses pair and sync.
    const code = (await h.call('POST', '/v1/devices/pairing-codes', { token: T })).body.code;
    const device = (await h.call('POST', '/v1/devices/pair', { body: { code } })).body.token;
    const library = await h.call('GET', '/v1/projects', { token: device });
    assert.equal(library.body.projects[0].currentRelease.id, pub.body.release.id);

    const manifest = await h.call('GET', `/v1/projects/${projectId}/releases/latest`, { token: device });
    assert.equal(manifest.status, 200);
    const etag = manifest.headers.get('etag')!;
    const unchanged = await h.call('GET', `/v1/projects/${projectId}/releases/latest`, { token: device, headers: { 'if-none-match': etag } });
    assert.equal(unchanged.status, 304);

    const res = await h.app.request(manifest.body.release.packageUrl, { headers: { authorization: `Bearer ${device}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha, manifest.body.release.packageSha256);
    assert.equal(res.headers.get('etag'), `"${sha}"`);
    const pkg = JSON.parse(bytes.toString());
    const validated = validateDefinition(definition);
    assert.ok(validated.ok);
    assert.deepEqual(pkg.definition, validated.definition);
    assert.equal(pkg.revisionNumber, 1);
    const cached = await h.app.request(manifest.body.release.packageUrl, {
      headers: { authorization: `Bearer ${device}`, 'if-none-match': `"${sha}"` },
    });
    assert.equal(cached.status, 304);

    // Local actions happen offline; then one batched backup.
    const backup = await h.call('PUT', `/v1/projects/${projectId}/state`, {
      token: device,
      body: { operationId: 'sync-1', sequence: 7, revisionId: revision.id, schemaVersion: 1, expectedServerVersion: 0, snapshot: { rows: 12 } },
    });
    assert.equal(backup.body.serverVersion, 1);

    // A replacement device recovers it.
    const code2 = (await h.call('POST', '/v1/devices/pairing-codes', { token: T })).body.code;
    const device2 = (await h.call('POST', '/v1/devices/pair', { body: { code: code2 } })).body.token;
    const restored = await h.call('GET', `/v1/projects/${projectId}/state`, { token: device2 });
    assert.deepEqual(restored.body.snapshot, { rows: 12 });
    assert.equal(restored.body.revisionId, revision.id);
  });

  test('two publishes racing on the same base: one wins, the other is superseded', async () => {
    const projectId = (await h.call('POST', '/v1/projects', { token: T, body: { title: 'Race' } })).body.project.id;
    const mk = async (title: string) =>
      (await h.call('POST', `/v1/projects/${projectId}/revisions`, { token: T, body: { definition: { ...FIXTURES.rowCounter, title } } })).body.revision.id;
    const [r1, r2] = [await mk('one'), await mk('two')];
    const publish = (revisionId: string, key: string) =>
      h.call('POST', `/v1/projects/${projectId}/releases`, {
        token: T,
        body: { revisionId, expectedCurrentReleaseId: null },
        headers: { 'idempotency-key': key },
      });
    const a = await publish(r1, 'race-key-a');
    const b = await publish(r2, 'race-key-b');
    assert.equal(a.status, 202);
    assert.equal(b.status, 202, 'both accepted while nothing is live yet');
    const [ja, jb] = [await drain(a.body.job.id), await drain(b.body.job.id)];
    assert.deepEqual([ja.result.status, jb.result.status].sort(), ['ready', 'superseded']);
    const project = (await h.call('GET', `/v1/projects/${projectId}`, { token: T })).body.project;
    const winner = ja.result.status === 'ready' ? a : b;
    assert.equal(project.currentReleaseId, winner.body.release.id);

    // Publishing on top now needs the winner as the expected base.
    const stale = await publish(r1, 'race-key-c');
    assert.equal(stale.status, 409);
  });

  test('generation with the fake model saves a valid revision and a reply, then iterates', async () => {
    const projectId = (await h.call('POST', '/v1/projects', { token: T, body: { title: 'New applet' } })).body.project.id;
    const msg = await h.call('POST', `/v1/projects/${projectId}/messages`, { token: T, body: { text: 'Make a crochet row counter', model: 'fake:demo' } });
    assert.equal(msg.status, 202, JSON.stringify(msg.body));
    const job = await drain(msg.body.job.id);
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    assert.equal(job.usage.model, 'fake:demo');
    const rev = await h.call('GET', `/v1/projects/${projectId}/revisions/${job.result.revisionId}`, { token: T });
    assert.equal(rev.body.revision.source, 'model');
    assert.equal(rev.body.revision.definition.title, 'Row counter');
    const thread = (await h.call('GET', `/v1/projects/${projectId}/messages`, { token: T })).body.messages;
    assert.deepEqual(thread.map((m: any) => m.role), ['user', 'assistant']);
    const project = (await h.call('GET', `/v1/projects/${projectId}`, { token: T })).body.project;
    assert.equal(project.title, 'Row counter', 'named after its first applet');

    // A follow-up revises on top of the latest revision.
    const msg2 = await h.call('POST', `/v1/projects/${projectId}/messages`, { token: T, body: { text: 'make it a packing checklist', model: 'fake:demo' } });
    const job2 = await drain(msg2.body.job.id);
    const rev2 = await h.call('GET', `/v1/projects/${projectId}/revisions/${job2.result.revisionId}`, { token: T });
    assert.equal(rev2.body.revision.baseRevisionId, job.result.revisionId);
  });

  test('models not on the allow-list are refused', async () => {
    const projectId = (await h.call('POST', '/v1/projects', { token: T, body: { title: 'Gen' } })).body.project.id;
    const msg = await h.call('POST', `/v1/projects/${projectId}/messages`, { token: T, body: { text: 'x', model: 'openrouter:someone/expensive' } });
    assert.equal(msg.status, 400);
    const models = await h.call('GET', '/v1/authoring/models', { token: T });
    assert.ok(models.body.models.some((m: any) => m.id === 'fake:demo'));
  });

  test('without a model key, generation fails once with a readable reply', async () => {
    const projectId = (await h.call('POST', '/v1/projects', { token: T, body: { title: 'Gen' } })).body.project.id;
    const msg = await h.call('POST', `/v1/projects/${projectId}/messages`, { token: T, body: { text: 'Make a counter' } });
    const job = await drain(msg.body.job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'model_not_configured');
    assert.equal(job.attempts, 1);
    const thread = (await h.call('GET', `/v1/projects/${projectId}/messages`, { token: T })).body.messages;
    assert.match(thread.at(-1).body, /set up/);
  });

  test('uploads are prepared by the worker', async () => {
    const up = await h.call('POST', '/v1/uploads', {
      token: T,
      body: new TextEncoder().encode('Row 1: chain 10'),
      headers: { 'content-type': 'text/plain' },
    });
    const job = await drain(up.body.job.id);
    assert.equal(job.status, 'succeeded');
    const upload = await h.call('GET', `/v1/uploads/${up.body.upload.id}`, { token: T });
    assert.equal(upload.body.upload.status, 'ready');
  });
});
