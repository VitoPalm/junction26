import { expect, test } from '@playwright/test';

// Real IndexedDB and sync code, mocked transport; no backend or Meta AI needed.
test('backup keeps snapshot revision and advances server version across concurrent local edits', async ({ page }) => {
  await page.goto('/glasses/');
  await expect(page.getByRole('heading', { name: 'Your solutions' })).toBeVisible();
  const result = await page.evaluate(async () => {
    const syncPath = '/glasses/src/sync.ts';
    const storePath = '/glasses/src/store.ts';
    const { sync, saveState } = await import(syncPath);
    const { store } = await import(storePath);
    const demo = (await store.applets())[0];
    const projectId = 'sync-test';
    await store.putApplet({ ...demo, projectId, demo: false, revisionId: 'revision-2' });
    await store.putMeta('pairing', { deviceId: 'device-1', token: 'test', pairedAt: '' });
    const snapshot = { revision: 'revision-1', values: {}, orphaned: {}, nextItem: {}, view: 'home' };
    await saveState(projectId, snapshot);
    const requests: Record<string, unknown>[] = [];
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/projects')) return Response.json({ projects: [] });
      if (init?.method === 'PUT') {
        requests.push(JSON.parse(String(init.body)));
        if (requests.length === 1) await saveState(projectId, { ...snapshot, values: { rows: 1 } });
        return Response.json({ serverVersion: requests.length });
      }
      return Response.json({ counts: [] });
    };
    try {
      await sync();
      const first = await store.state(projectId);
      await sync();
      const second = await store.state(projectId);
      return { requests, first, second };
    } finally { window.fetch = original; }
  });
  expect(result.requests[0].revisionId).toBe('revision-1');
  expect(result.first).toMatchObject({ dirty: true, serverVersion: 1, sequence: 2 });
  expect(result.requests[1].expectedServerVersion).toBe(1);
  expect(result.requests[1].snapshot).toMatchObject({ values: { rows: 1 } });
  expect(result.second).toMatchObject({ dirty: false, serverVersion: 2 });
});
