import { expect, test, type Page, type Route } from '@playwright/test';

// Task coach in the real glasses app at 600×600 (docs/task-coach.md).
// Voice goes through the explicit dev WebMCP stub, and the coach API is mocked
// with Playwright routes: this checks the glasses client (persistence, retry,
// idempotent resend, polling, confirmation). It does not exercise Meta AI, the
// simulator's agent, the real API/worker, or the glasses hardware.

type Result = Record<string, unknown> & { ok?: boolean; error?: string; status?: string; answer?: string };
declare global {
  interface Window {
    webmcp: { list(): { name: string }[]; call(name: string, args?: Record<string, unknown>): Promise<Result> };
  }
}

const PROJECT = '11111111-1111-4111-8111-111111111111';
const call = (page: Page, name: string, args: Record<string, unknown> = {}) => page.evaluate(([n, a]) => window.webmcp.call(n as string, a as Record<string, unknown>), [name, args] as const);

async function noScroll(page: Page) {
  await page.mouse.wheel(0, 800);
  expect(await page.evaluate(() => [window.scrollY, document.scrollingElement!.scrollHeight <= window.innerHeight])).toEqual([0, true]);
  await expect(page.getByRole('alert')).toHaveCount(0); // fit guard
}

async function openDemo(page: Page) {
  await page.goto('/glasses/?webmcp');
  await page.evaluate(() => new Promise<void>((res) => { const r = indexedDB.deleteDatabase('junction26-glasses'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
  await page.goto('/glasses/?webmcp');
  await page.getByRole('button', { name: /Two-shelf bookcase/ }).click();
  // Image-first: the step is its diagram (alt = the instruction) plus one caption line.
  await expect(page.getByRole('img', { name: 'Lay out every part and count it against the parts list.' })).toBeVisible();
}

test('one step at a time; D-pad, More menu, parts, repeat, complete and local answers work offline and persist', async ({ page }) => {
  await openDemo(page);
  await expect(page.getByText(/Step 1 of 9 · p\. 2/i)).toBeVisible();
  await noScroll(page);

  // D-pad: arrows move a visible focus; Enter activates once.
  for (let i = 0; i < 8; i++) {
    if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) === 'Next') break;
    await page.keyboard.press(i < 4 ? 'ArrowDown' : 'ArrowRight');
  }
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Next');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Step 2 of 9/i)).toBeVisible();
  await expect(page.getByText('⚠ Do not overtighten.')).toBeVisible();
  await expect(page.getByText('Screw the 4 cam bolts', { exact: false })).toHaveCount(0); // full text only under Read step

  // More → Show parts (paged list, no scrolling) → back.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  for (const item of ['Read step', 'Show parts', 'Ask a question']) await expect(page.getByRole('button', { name: item, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show parts', exact: true }).click();
  await expect(page.getByRole('button', { name: /Cam bolt \(A\)/ })).toBeVisible();
  await noScroll(page);
  await page.getByRole('button', { name: 'Back to step', exact: true }).click();

  // Read step shows the instruction with its caution and page.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Read step', exact: true }).click();
  await expect(page.getByText(/Step 2: Screw the 4 cam bolts/)).toBeVisible();
  await expect(page.getByText(/Manual p\. 2, Step 2/)).toBeVisible();
  await page.getByRole('button', { name: 'OK', exact: true }).click();

  // Ask (preset) is answered locally from the parts list, with a source.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Ask a question', exact: true }).click();
  await page.getByRole('button', { name: 'Which parts do I need?', exact: true }).click();
  await expect(page.getByText(/4 × Cam bolt \(A\)/)).toBeVisible();
  await page.getByRole('button', { name: 'OK', exact: true }).click();

  // Complete (band) and complete_step (voice) both mark progress.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Next page', exact: true }).click(); // three choices per page, no scrolling
  await page.getByRole('button', { name: 'Complete step', exact: true }).click();
  await expect(page.getByText(/Step 3 of 9/i)).toBeVisible();
  expect((await call(page, 'j26_shelf_complete_step')).now).toBe(4);
  const ctx = (await call(page, 'j26_shelf_coach_context')).context as { progress: { completed: number } };
  expect(ctx.progress.completed).toBe(2);

  // No network needed for navigation or completion (the dev server has no
  // service worker, so offline cold start is checked against the production build).
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText(/Step 5 of 9/i)).toBeVisible();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByText(/Step 4 of 9/i)).toBeVisible(); // shown only after the save commits
  await page.context().setOffline(false);

  // Close and reopen: position and completed steps come back from IndexedDB.
  await page.reload();
  await expect(page.getByText(/Step 4 of 9/i)).toBeVisible();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByText(/Step 3 of 9.*✓/i)).toBeVisible(); // completed steps keep their tick
});

/** Installs the bookcase as a paired, published (non-demo) applet with a fake device token. */
async function openPaired(page: Page) {
  await openDemo(page);
  await page.evaluate(async (projectId) => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open('junction26-glasses', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const get = <T,>(store: string, key: string) => new Promise<T>((res) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result as T); });
    const demo = await get<Record<string, unknown>>('applets', 'demo-bookcaseGuide');
    await new Promise<void>((res, rej) => {
      const t = db.transaction(['applets', 'meta', 'state'], 'readwrite');
      // Only the paired guide: with more than three solutions the paired home
      // screen docks Older + Sync + Voice and trips the two-action guard
      // (an existing home-screen issue, outside this test's scope).
      for (const k of ['rowCounter', 'characterSheet', 'packingList', 'pancakeGuide', 'bookcaseGuide']) {
        t.objectStore('applets').delete(`demo-${k}`);
        t.objectStore('state').delete(`demo-${k}`);
      }
      t.objectStore('applets').put({ ...demo, projectId, demo: false, releaseId: 'rel1', revisionId: 'rev1' });
      t.objectStore('meta').put({ token: 'j26d_test-token', deviceId: 'dev1', pairedAt: new Date().toISOString() }, 'pairing');
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }, PROJECT);
  await page.goto('/glasses/?webmcp');
  await page.getByRole('button', { name: /Two-shelf bookcase/ }).click();
  await expect(page.getByText(/Step 1 of 9/i)).toBeVisible();
}

const proposal = {
  kind: 'problem',
  recovery: {
    status: 'proposal', title: 'Redo: Left side', rationale: 'Undo the part that went on the wrong way, then fit it again.', returnStepId: 'left_side',
    sources: [{ page: 3, section: 'Step 4' }],
    steps: [
      { text: 'Undo that step: loosen any cam locks and take the part off.', source: { page: 3, section: 'Step 4' } },
      { text: 'Turn the part around so it matches the manual.', source: { page: 3, section: 'Step 4' } },
      { text: 'Fit it again as in step 4.', source: { page: 3, section: 'Step 4' } },
    ],
  },
};

test('problem report: offline retry with the same operation, resume after reload, clarification, confirm and return', async ({ page }) => {
  const posts: Record<string, unknown>[] = [];
  let offline = true;
  let release: unknown = null;
  let gets = 0;
  await page.route('**/v1/coach/requests', async (route: Route) => {
    if (offline) return route.abort('internetdisconnected');
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    expect(route.request().headers().authorization).toBe('Bearer j26d_test-token');
    await route.fulfill({ status: 202, json: { request: { id: `job${posts.length}`, status: 'queued', result: null, error: null } } });
  });
  await page.route('**/v1/coach/requests/job*', async (route: Route) => {
    gets++;
    const id = route.request().url().split('/').pop();
    const done = release && id === `job${posts.length}`;
    await route.fulfill({ json: { request: { id, status: done ? 'succeeded' : 'running', result: done ? release : null, error: null } } });
  });

  await openPaired(page);
  for (let i = 0; i < 4; i++) await call(page, 'j26_shelf_next_step');
  await expect(page.getByText(/Step 5 of 9/i)).toBeVisible();

  // Vague report by voice → no connection → Retry resends the same operation.
  expect((await call(page, 'j26_shelf_report_problem', { problem: 'something is wrong' })).status).toBe('checking');
  await expect(page.getByText('No connection. It will retry.')).toBeVisible();
  offline = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ projectId: PROJECT, kind: 'problem', stepId: 'cam_locks', text: 'something is wrong', clarifications: [] });

  // The server asks a clarifying question; picking an option sends a new request with it.
  release = { kind: 'problem', recovery: { status: 'clarify', question: 'What happened?', options: ['Fitted it backwards', 'A part is missing', 'Something else'] } };
  await expect(page.getByRole('button', { name: 'Fitted it backwards', exact: true })).toBeVisible();
  release = null;
  await page.getByRole('button', { name: 'Fitted it backwards', exact: true }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toMatchObject({ text: 'something is wrong', clarifications: ['Fitted it backwards'] });
  expect(posts[1]!.operationId).not.toBe(posts[0]!.operationId);

  // Close the app while it's pending: the request comes back and polling resumes.
  await expect(page.getByText('Finding a fix')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Finding a fix')).toBeVisible();
  const before = gets;
  await expect.poll(() => gets).toBeGreaterThan(before);
  expect(posts.length).toBe(2); // resumed by job ID, not resubmitted

  // Proposal needs explicit confirmation; nothing changes until then.
  release = proposal;
  await expect(page.getByText('Proposed fix · 3 steps')).toBeVisible();
  await expect(page.getByText(/Then back to step 4/)).toBeVisible();
  await noScroll(page);
  await page.getByRole('button', { name: 'Use this fix', exact: true }).click();
  await expect(page.getByText('Fix 1 of 3')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Back to guide', exact: true }).click();
  await expect(page.getByText(/Step 4 of 9/i)).toBeVisible();
  await expect(page.getByRole('img', { name: 'Fit the left side panel onto both shelves so the cam bolts enter the large holes.' })).toBeVisible();
});

test('declining a fix and cancelling a question leave the guide untouched', async ({ page }) => {
  const cancels: string[] = [];
  let n = 0;
  await page.route('**/v1/coach/requests', (route) => route.fulfill({ status: 202, json: { request: { id: `job${++n}`, status: 'queued', result: null, error: null } } }));
  await page.route('**/v1/coach/requests/*/cancel', (route) => { cancels.push(route.request().url()); return route.fulfill({ status: 202, json: { request: { id: 'x', status: 'cancelled', result: null, error: null } } }); });
  await page.route(/\/v1\/coach\/requests\/job\d+$/, (route) => route.fulfill({ json: { request: { id: 'job1', status: n === 1 ? 'succeeded' : 'running', result: n === 1 ? proposal : null, error: null } } }));

  await openPaired(page);
  for (let i = 0; i < 4; i++) await call(page, 'j26_shelf_complete_step');
  await call(page, 'j26_shelf_report_problem', { problem: 'I attached the left side backwards' });
  await expect(page.getByText('Proposed fix · 3 steps')).toBeVisible();
  expect((await call(page, 'j26_shelf_cancel_fix')).ok).toBe(true);
  await expect(page.getByText(/Step 5 of 9/i)).toBeVisible();

  // A question that needs the backend: cancel while it's pending.
  expect((await call(page, 'j26_shelf_ask_question', { question: 'Can I use wood glue on the dowels?' })).status).toBe('checking');
  await expect(page.getByText('Checking the manual')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText(/Step 5 of 9/i)).toBeVisible();
  await expect.poll(() => cancels.length).toBeGreaterThan(0);
  const ctx = (await call(page, 'j26_shelf_coach_context')).context as { progress: { completed: number }; recovery: unknown };
  expect(ctx).toMatchObject({ progress: { completed: 4 }, recovery: null });
});

test('image-first: every step shows its diagram with one caption line and fits', async ({ page }) => {
  await openDemo(page);
  for (let i = 0; i < 9; i++) {
    await expect(page.getByText(new RegExp(`^Step ${i + 1} of 9`, 'i'))).toBeVisible();
    await expect(page.locator('.g-diagram')).toHaveCount(1);
    const box = await page.locator('.g-diagram').boundingBox();
    expect(box!.height).toBeGreaterThan(150); // the picture gets the room, not text
    const hint = page.locator('.g-caption .g-hint');
    if (await hint.count()) expect((await hint.boundingBox())!.height).toBeLessThan(45); // one line
    await noScroll(page);
    if (i < 8) await call(page, 'j26_shelf_next_step');
  }
});
