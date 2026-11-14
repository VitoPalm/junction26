import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES } from '@junction26/applet-format';
import { skipWithoutDatabase } from '@junction26/db/testing';
import { assistantCapabilities, validateAssistantDefinition } from './assistant-definition.ts';
import { createHarness, type Harness } from './test-support/harness.ts';

const definition = FIXTURES.rowCounter;

test('external capabilities and validation use the current format', () => {
  const capabilities = assistantCapabilities(512 * 1024);
  assert.equal(capabilities.formatVersion, 1);
  assert.ok(capabilities.schema);
  assert.equal(validateAssistantDefinition(definition, 512 * 1024).ok, true);
  assert.equal(validateAssistantDefinition({ formatVersion: 1, title: 'Incomplete' }, 512 * 1024).ok, false);
  assert.equal(validateAssistantDefinition(definition, 10).ok, false);
  assert.equal(validateAssistantDefinition({ ...definition, assets: [{ id: 'image', mediaType: 'image/png', uploadId: 'external' }] }, 512 * 1024).ok, false);
});

describe('external assistant drafts', { skip: skipWithoutDatabase }, () => {
  let h: Harness;
  const token = 'dev:assistant';
  const create = { mode: 'create', title: 'Counter', definition };
  const submit = (body: unknown, key: string, user = token) => h.call('POST', '/v1/assistant/drafts', { token: user, body, headers: { 'idempotency-key': key } });
  before(async () => { h = await createHarness(); });
  after(async () => { await h?.close(); });

  test('invalid drafts are rejected without creating a project', async () => {
    const invalid = await submit({ ...create, definition: { formatVersion: 1, title: 'Invalid' } }, 'invalid-draft');
    assert.equal(invalid.status, 422);
    assert.ok(invalid.body.error.details.issues.length);
    assert.equal((await h.call('GET', '/v1/projects', { token })).body.projects.length, 0);
  });

  test('concurrent create and revise retries replay durable IDs, including reordered JSON keys', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => submit(create, 'concurrent-create')));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 201]);
    const saved = results[0]!.body;
    assert.ok(results.every((r) => r.body.revision.id === saved.revision.id && r.body.project.id === saved.project.id));
    assert.equal((await h.call('GET', '/v1/projects', { token })).body.projects.length, 1);
    assert.equal(saved.measuredFit, 'not_checked');
    assert.equal(saved.published, false);
    assert.match(saved.previewUrl, /\/author\/p\//);
    const reordered = Object.fromEntries(Object.entries(create).reverse());
    assert.equal((await submit(reordered, 'concurrent-create')).status, 200);
    assert.equal((await submit({ ...create, title: 'Different' }, 'concurrent-create')).status, 409);

    const revision = { mode: 'revise', projectId: saved.project.id, baseRevisionId: saved.revision.id, definition: { ...definition, title: 'New layout' } };
    const revised = await Promise.all([submit(revision, 'concurrent-revise'), submit(revision, 'concurrent-revise')]);
    assert.deepEqual(revised.map((r) => r.status).sort(), [200, 201]);
    assert.equal(revised[0]!.body.revision.id, revised[1]!.body.revision.id);
    assert.equal((await submit(revision, 'stale-base-key')).body.error.code, 'stale_revision');
    assert.equal((await submit(revision, 'cross-owner-key', 'dev:other')).status, 404);
    assert.equal((await h.call('GET', `/v1/projects/${saved.project.id}/revisions/${saved.revision.id}`, { token: 'dev:other' })).status, 404);
    const backup = await h.db.pool.query('SELECT count(*)::int AS n FROM state_backups');
    assert.equal(backup.rows[0].n, 0);
    const jobs = await h.db.pool.query('SELECT count(*)::int AS n FROM jobs');
    assert.equal(jobs.rows[0].n, 0);
  });

  test('change findings are persisted and block existing publication route', async () => {
    const saved = (await submit(create, 'review-create')).body;
    const next = { ...definition, home: {}, actions: [], views: definition.views.map((v) => {
      const { actions, ...rest } = v as typeof v & { actions?: string[] }; return rest;
    }) };
    const valid = await submit({ mode: 'revise', projectId: saved.project.id, baseRevisionId: saved.revision.id, definition: next }, 'review-revise');
    assert.equal(valid.status, 201);
    assert.equal(valid.body.reviewRequired, true);
    assert.ok(valid.body.findings.some((f: { kind: string }) => f.kind === 'action_removed'));
    const published = await h.call('POST', `/v1/projects/${saved.project.id}/releases`, { token, body: { revisionId: valid.body.revision.id, expectedCurrentReleaseId: null }, headers: { 'idempotency-key': 'review-publish' } });
    assert.equal(published.status, 409);
    assert.equal(published.body.error.code, 'review_required');
  });

  test('draft chains retain impacts relative to the published revision', async () => {
    const saved = (await submit(create, 'chain-create')).body;
    // Seed the immutable release pointer; packaging itself is covered by e2e.test.ts.
    const release = await h.db.pool.query("INSERT INTO releases (project_id, revision_id, status) VALUES ($1, $2, 'pending') RETURNING id", [saved.project.id, saved.revision.id]);
    await h.db.pool.query('UPDATE projects SET current_release_id = $1 WHERE id = $2', [release.rows[0].id, saved.project.id]);
    const next = { ...definition, home: {}, actions: [], views: definition.views.map((v) => {
      const { actions, ...rest } = v as typeof v & { actions?: string[] }; return rest;
    }) };
    const first = await submit({ mode: 'revise', projectId: saved.project.id, baseRevisionId: saved.revision.id, definition: next }, 'chain-first');
    assert.equal(first.status, 201);
    const second = await submit({ mode: 'revise', projectId: saved.project.id, baseRevisionId: first.body.revision.id, definition: { ...next, title: 'Another draft' } }, 'chain-second');
    assert.equal(second.status, 201);
    assert.equal(second.body.reviewRequired, true);
    assert.ok(second.body.findings.some((f: { kind: string }) => f.kind === 'action_removed'));
  });

  test('device credentials cannot discover or submit authoring tools', async () => {
    const code = (await h.call('POST', '/v1/devices/pairing-codes', { token })).body.code;
    const device = (await h.call('POST', '/v1/devices/pair', { body: { code } })).body.token;
    assert.equal((await h.call('GET', '/v1/assistant/capabilities', { token: device })).status, 403);
    assert.equal((await submit(create, 'device-create', device)).status, 403);
    assert.equal((await h.call('GET', '/v1/assistant/capabilities')).status, 401);
  });
});
