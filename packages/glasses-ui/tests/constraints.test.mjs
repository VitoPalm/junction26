import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCopy, checkIds, assertContent } from '../dist-lib/constraints.js';

test('rejects long generated instructions with a useful field path, without truncating input', () => {
  const original = 'A'.repeat(181);
  const issues = checkCopy('steps.2.text', original, 180);
  assert.equal(issues[0].path, 'steps.2.text');
  assert.match(issues[0].message, /another screen/);
  assert.throws(() => assertContent(issues), /steps.2.text/);
  assert.equal(original.length, 181);
});

test('counts Unicode code points and accepts the exact boundary', () => {
  assert.deepEqual(checkCopy('title', '🧶'.repeat(32), 32), []);
  assert.equal(checkCopy('title', '🧶'.repeat(33), 32).length, 1);
  assert.equal(checkCopy('title', '   ', 32).length, 1);
});

test('protects component identity across generated revisions', () => {
  assert.deepEqual(checkIds([{ id: 'inventory' }, { id: 'health' }]), []);
  assert.deepEqual(checkIds([{ id: 'inventory' }, { id: 'inventory' }, { id: '' }]).map(i => i.path), ['items[1].id', 'items[2].id']);
});

test('pages long instructions without dropping words or exceeding the copy budget', async () => {
  const { paginateText, COPY_LIMITS } = await import('../dist-lib/constraints.js');
  const original = 'Use the supplied fasteners. '.repeat(20).trim();
  const pages = paginateText(original);
  assert.ok(pages.length > 1);
  assert.equal(pages.join(' '), original);
  assert.ok(pages.every(p => Array.from(p).length <= COPY_LIMITS.body));
  assert.throws(() => paginateText(original, 0));
});
test('collection pages contain each item once without requiring a scrolling list', async () => {
  const { pageItems } = await import('../dist-lib/constraints.js');
  const items = Array.from({ length: 8 }, (_, id) => ({ id }));
  assert.deepEqual([0, 1, 2].flatMap(p => pageItems(items, p)), items);
  assert.equal(pageItems(items, 2).length, 2);
  assert.deepEqual(pageItems(items, 3), []);
});
