import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError } from './api.ts';

test('API retrieves current credentials for each request and refuses a signed-out session', async () => {
  const original = globalThis.fetch;
  const headers: string[] = [];
  let token: string | null = 'first';
  globalThis.fetch = async (_url, init) => {
    headers.push(new Headers(init?.headers).get('authorization')!);
    return Response.json({ projects: [] });
  };
  try {
    const api = createApi({ server: '', token: 'stale', name: 'Alice' }, async () => token);
    await api.projects();
    token = 'refreshed';
    await api.projects();
    token = null;
    await assert.rejects(api.projects(), (err: unknown) => err instanceof ApiError && err.status === 401);
    assert.deepEqual(headers, ['Bearer first', 'Bearer refreshed']);
  } finally { globalThis.fetch = original; }
});

import { chooseModel, modelSummary } from './model-selection.ts';
import type { ModelOption } from './api.ts';

test('model selection skips unavailable defaults and respects an available preference', () => {
  const models: ModelOption[] = [
    { id: 'anthropic:x', label: 'Claude', provider: 'anthropic', free: false, default: true, available: false, unavailableReason: 'Needs configuration' },
    { id: 'fake:demo', label: 'Demo', provider: 'fake', free: true, default: false, available: true, unavailableReason: null },
    { id: 'local:x', label: 'Local', provider: 'local', free: false, default: false, available: true, unavailableReason: null, capabilities: { images: false, files: false, audio: false, structuredOutput: false } },
  ];
  assert.equal(chooseModel(models, 'anthropic:x'), 'fake:demo');
  assert.equal(chooseModel(models, 'local:x'), 'local:x');
  assert.equal(chooseModel([], ''), '');
  assert.match(modelSummary(models[0]!), /Needs configuration/);
  assert.match(modelSummary(models[1]!), /Free demo/);
  assert.equal(modelSummary(models[2]!), 'Text only');
});
