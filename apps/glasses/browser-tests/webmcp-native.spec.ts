import { expect, test, type Page } from '@playwright/test';

// Desktop Chrome's own WebMCP (document.modelContext), not the dev stub.
// Opt-in: NATIVE_WEBMCP=1 launches Chrome with --enable-features=WebMCP
// (see playwright.config.ts); skipped when the browser has no modelContext.
// Drives tools through executeTool the way the host does (Meta's guidance).
// This is desktop evidence only: it says nothing about Meta AI choosing these
// tools or about voice routing on the glasses.

interface NativeTool { name: string; description: string }
interface NativeModelContext {
  getTools(): Promise<NativeTool[]>;
  executeTool(tool: NativeTool, input: string | Record<string, unknown>): Promise<unknown>;
}

const names = (page: Page) => page.evaluate(async () => ((await (document as unknown as { modelContext: NativeModelContext }).modelContext.getTools()).map((t) => t.name)));
const exec = (page: Page, name: string, args: Record<string, unknown> = {}) =>
  page.evaluate(async ([n, a]) => {
    const mc = (document as unknown as { modelContext: NativeModelContext }).modelContext;
    const tool = (await mc.getTools()).find((t) => t.name === n);
    if (!tool) throw new Error(`no tool ${n}`);
    // Meta's guide passes a JSON string; Chrome 157 desktop (--enable-features=WebMCP)
    // requires an object and throws TypeError for a string. Accept either build.
    let raw: unknown;
    try {
      raw = await mc.executeTool(tool, a as Record<string, unknown>);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      raw = await mc.executeTool(tool, JSON.stringify(a));
    }
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }, [name, args] as const);

test('native desktop WebMCP: coach tools are discovered, invoked, and removed on leaving', async ({ page }) => {
  await page.goto('/glasses/');
  const native = await page.evaluate(() => typeof (document as unknown as { modelContext?: unknown }).modelContext === 'object');
  test.skip(!native, 'This Chrome has no native document.modelContext (run with NATIVE_WEBMCP=1).');
  await page.evaluate(() => new Promise<void>((res) => { const r = indexedDB.deleteDatabase('junction26-glasses'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
  await page.reload();
  expect(await page.evaluate(() => 'webmcp' in window)).toBe(false); // no stub: the real API

  await page.getByRole('button', { name: /Two-shelf bookcase/ }).click();
  await expect.poll(() => names(page)).toContain('j26_shelf_ask_question');
  const listed = await names(page);
  for (const n of ['next_step', 'previous_step', 'coach_context', 'repeat_step', 'show_parts', 'complete_step', 'ask_question', 'report_problem', 'choose_option', 'confirm_fix', 'cancel_fix'])
    expect(listed).toContain(`j26_shelf_${n}`);

  expect(await exec(page, 'j26_shelf_complete_step')).toMatchObject({ ok: true, now: 2 });
  await expect(page.getByText(/Step 2 of 9/i)).toBeVisible();
  const answer = await exec(page, 'j26_shelf_ask_question', { question: 'Which screws do I need?' });
  expect(answer.answer).toMatch(/Cam bolt \(A\)/);
  expect(answer.sources[0]).toEqual({ page: 2, section: 'Step 2' });
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  expect(await exec(page, 'j26_shelf_ask_question', { question: '' })).toMatchObject({ error: 'invalid_question' });
  expect(await exec(page, 'j26_shelf_next_step')).toMatchObject({ ok: true });
  await expect(page.getByText(/Step 3 of 9/i)).toBeVisible();
  const ctx = await exec(page, 'j26_shelf_coach_context');
  expect(ctx.context.step).toMatchObject({ id: 'dowels', number: 3 });

  // Leaving the guide unregisters its tools (AbortSignal), and reopening registers them again without duplicates.
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your solutions', exact: true })).toBeVisible();
  await expect.poll(() => names(page)).toEqual([]);
  const errors: string[] = [];
  page.on('console', (m) => { if (/already registered|InvalidStateError/.test(m.text())) errors.push(m.text()); });
  await page.getByRole('button', { name: /Two-shelf bookcase/ }).click();
  await expect.poll(() => names(page)).toContain('j26_shelf_next_step');
  expect(errors).toEqual([]);
});
