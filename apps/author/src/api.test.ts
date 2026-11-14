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
