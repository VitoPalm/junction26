import { expect, test, type Page } from '@playwright/test';

// These exercise the real app, runtime and IndexedDB through the explicit dev
// stub. They do not exercise Meta AI or the simulator extension's agent.
type Result = { ok?: boolean; error?: string; values?: Record<string, unknown> };
declare global {
  interface Window {
    webmcp: { list(): { name: string }[]; call(name: string, args?: Record<string, unknown>): Promise<Result> };
  }
}

/** Taps an example on home; home shows the latest three, the rest are under Older. Returns true if it went through Older. */
async function tapExample(page: Page, name: string): Promise<boolean> {
  const tile = page.getByRole('button', { name: new RegExp(name) });
  await expect(page.getByRole('button', { name: /Example/ }).first()).toBeVisible();
  const viaOlder = !(await tile.isVisible());
  if (viaOlder) {
    await page.getByRole('button', { name: 'Older', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Older solutions' })).toBeVisible();
    await expect(page.getByRole('button').first()).toBeVisible();
    for (let i = 0; i < 4 && !(await tile.isVisible({ timeout: 1000 }).catch(() => false)); i++) await page.getByRole('button', { name: 'Next page', exact: true }).click();
  }
  await tile.click();
  return viaOlder;
}

/** Opens an example; returns true when it was reached through Older (one more Back to get home). */
async function open(page: Page, name = 'Brakka the Bold'): Promise<boolean> {
  await page.goto('/glasses/?webmcp');
  const viaOlder = await tapExample(page, name);
  await expect.poll(() => page.evaluate(() => window.webmcp.list().length)).toBeGreaterThan(0);
  return viaOlder;
}

test('tool writes are immediately readable, serialize, and survive reload', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    await window.webmcp.call('j26_dnd_take_damage', { amount: 5 });
    const immediate = await window.webmcp.call('j26_dnd_read_state');
    await Promise.all(Array.from({ length: 4 }, () => window.webmcp.call('j26_dnd_take_damage', { amount: 1 })));
    const concurrent = await window.webmcp.call('j26_dnd_read_state');
    return { immediate: immediate.values!.Health, concurrent: concurrent.values!.Health };
  });
  expect(result).toEqual({ immediate: 19, concurrent: 15 });
  await expect(page.getByText('15 / 24', { exact: true })).toBeVisible();
  await page.reload(); // Route changes remove ?webmcp; persistence is independent of the stub.
  await expect(page.getByText('15 / 24', { exact: true })).toBeVisible();
});

test('manual and tool actions share state; invalid arguments do not mutate it', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Hit −1', exact: true }).click();
  await expect(page.getByText('23 / 24', { exact: true })).toBeVisible();
  const result = await page.evaluate(async () => {
    const invalid = await window.webmcp.call('j26_dnd_take_damage', { amount: 'oops' });
    const missing = await window.webmcp.call('j26_dnd_adjust_max_health', {});
    const state = await window.webmcp.call('j26_dnd_read_state');
    await window.webmcp.call('j26_dnd_heal', { amount: 100 });
    return { invalid, missing, health: state.values!.Health };
  });
  expect(result.invalid.error).toBeTruthy();
  expect(result.missing.error).toBeTruthy();
  expect(result.health).toBe(23);
  await expect(page.getByText('24 / 24', { exact: true })).toBeVisible();
});

test('navigation keeps tools usable and switching applets removes old tools', async ({ page }) => {
  const viaOlder = await open(page);
  await page.evaluate(() => window.webmcp.call('j26_dnd_open_view', { page: 'Inventory' }));
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await page.evaluate(() => window.webmcp.call('j26_dnd_add_item', { name: 'Test crystal', qty: 2 }));
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('button', { name: /Test crystal/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Health', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Brakka the Bold', exact: true })).toBeVisible();
  await page.goBack();
  if (viaOlder) await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your solutions', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.webmcp.list().length)).toBe(0);
  await tapExample(page, 'Pancakes');
  await expect.poll(() => page.evaluate(() => window.webmcp.list().map(t => t.name))).toEqual([
    'j26_pancake_read_state', 'j26_pancake_next_step', 'j26_pancake_previous_step',
    'j26_pancake_start_voice_note', 'j26_pancake_stop_voice_note',
  ]);
  await page.evaluate(() => window.webmcp.call('j26_pancake_next_step'));
  await expect(page.getByText(/Beat 2 eggs/)).toBeVisible();
  await page.evaluate(() => window.webmcp.call('j26_pancake_previous_step'));
  await expect(page.getByText(/Whisk 200 g flour/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Whisk 200 g flour/)).toBeVisible();
});

test('voice note tools refuse politely on bundled examples (they have no phone copy)', async ({ page }) => {
  await page.goto('/glasses/?webmcp');
  await tapExample(page, 'Pancakes');
  await expect.poll(() => page.evaluate(() => window.webmcp.list().length)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Record note' })).toBeVisible();
  await expect(page.getByText('Say “Hey Meta, record a note”')).toBeVisible();
  const r = await page.evaluate(() => window.webmcp.call('j26_pancake_start_voice_note'));
  expect(r.error).toBe('demo_applet');
  await expect(page.getByText('Notes work on applets from your phone')).toBeVisible();
  const stop = await page.evaluate(() => window.webmcp.call('j26_pancake_stop_voice_note'));
  expect(stop.error).toBe('not_recording');
});
