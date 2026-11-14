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
