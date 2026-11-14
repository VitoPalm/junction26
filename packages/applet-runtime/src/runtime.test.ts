import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, validateDefinition, type AppletDefinition } from '@junction26/applet-format';
import { dispatch, initialState, migrateState, formatValue, describeState, type AppletState } from './index.ts';

function def(name: keyof typeof FIXTURES): AppletDefinition {
  const r = validateDefinition(FIXTURES[name]);
  assert.ok(r.ok);
  return r.definition;
}
function run(d: AppletDefinition, s: AppletState, id: string, args: Record<string, unknown> = {}) {
  const r = dispatch(d, s, id, args);
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r.state;
}

test('add/subtract use defaults, coerce strings and clamp', () => {
  const d = def('rowCounter');
  let s = initialState(d);
  s = run(d, s, 'add_row');
  s = run(d, s, 'add_row', { count: '3' });
  assert.equal(s.values.rows, 4);
  s = run(d, s, 'undo_row', { count: 10 });
  assert.equal(s.values.rows, 0, 'clamped at min');
  const bad = dispatch(d, s, 'add_row', { count: 1.5 });
  assert.equal(bad.ok, false);
  const missing = dispatch(d, s, 'set_rows', {});
  assert.ok(!missing.ok && missing.code === 'missing_argument');
});

test('state is never mutated in place', () => {
  const d = def('rowCounter');
  const s = initialState(d);
  run(d, s, 'add_row');
  assert.equal(s.values.rows, 0);
});

test('lists: append, fuzzy match, quantity, remove, full', () => {
  const d = def('characterSheet');
  let s = initialState(d);
  assert.equal((s.values.inventory as any[]).length, 4);
  s = run(d, s, 'add_item', { name: 'Gold coin', qty: 5 });
  const inv = s.values.inventory as any[];
  assert.equal(inv.at(-1).name, 'Gold coin');
  assert.equal(inv.at(-1).id, 'inventory_5');
  s = run(d, s, 'use_item', { name: 'potion' });
  assert.equal((s.values.inventory as any[])[0].qty, 1);
  s = run(d, s, 'remove_item', { name: 'ROPE' });
  assert.equal((s.values.inventory as any[]).length, 4);
  const none = dispatch(d, s, 'remove_item', { name: 'Sword' });
  assert.ok(!none.ok && none.code === 'no_match');
});

test('checklist toggle and value formatting', () => {
  const d = def('packingList');
  let s = run(d, initialState(d), 'toggle_item', { name: 'Map' });
  assert.equal((s.values.gear as any[]).find((i) => i.name === 'Map').packed, true);
  const cs = def('characterSheet');
  let c = run(cs, initialState(cs), 'take_damage', { amount: 5 });
  const view = cs.views[0]!;
  assert.equal(view.kind, 'value');
  if (view.kind === 'value') assert.equal(formatValue(view, c), '19 / 24');
  c = run(cs, c, 'long_rest');
  assert.equal(c.values.hp, 24);
  assert.ok(describeState(cs, c));
});

test('cursor moves within bounds', () => {
  const d = structuredClone(def('pancakeGuide'));
  d.actions.push({ id: 'next', label: 'Next', description: 'x', args: [], effects: [{ op: 'move', field: 'step', by: 1 }] });
  let s = initialState(d);
  for (let i = 0; i < 10; i++) s = run(d, s, 'next');
  assert.equal(s.values.step, 4);
});

test('migration keeps data, defaults new fields, orphans removed ones', () => {
  const d = def('characterSheet');
  let s = run(d, initialState(d, 'r1'), 'take_damage', { amount: 4 });
  const next = structuredClone(d);
  next.state = next.state.filter((f) => f.id !== 'slots');
  next.state.push({ id: 'gold', type: 'number', label: 'Gold', default: 10 });
  next.views = next.views.filter((v) => v.id !== 'spells');
  const m = migrateState(next, s, 'r2');
  assert.equal(m.values.hp, 20);
  assert.equal(m.values.gold, 10);
  assert.equal(m.orphaned.slots, 3);
  assert.equal(m.revision, 'r2');
  // Restoring the field later brings its value back.
  const back = migrateState(d, m, 'r3');
  assert.equal(back.values.slots, 3);
  assert.equal(back.orphaned.slots, undefined);
});
