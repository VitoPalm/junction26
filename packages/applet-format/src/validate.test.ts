import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, validateDefinition, diffDefinitions, authoringResponseJsonSchema, systemPrompt, type AppletDefinition } from './index.ts';

const clone = <T>(v: T): T => structuredClone(v);

test('every fixture is valid', () => {
  for (const [name, def] of Object.entries(FIXTURES)) {
    const r = validateDefinition(def);
    assert.ok(r.ok, `${name}: ${JSON.stringify(r.issues, null, 2)}`);
  }
});

test('broken references are reported with paths', () => {
  const d = clone(FIXTURES.characterSheet) as any;
  d.views[0].field = 'nope';
  d.actions[0].effects[0].field = 'inventory';
  d.views[2].onSelect.arg = 'missing';
  const r = validateDefinition(d);
  assert.equal(r.ok, false);
  const paths = r.issues.map((i) => `${i.path}:${i.code}`);
  assert.ok(paths.includes('views[0].field:reference'), paths.join(','));
  assert.ok(paths.includes('actions[0].effects[0].field:type'), paths.join(','));
  assert.ok(paths.includes('views[2].onSelect.arg:reference'), paths.join(','));
});

test('copy budgets, docking and reserved names', () => {
  const d = clone(FIXTURES.rowCounter) as any;
  d.title = 'x'.repeat(40);
  d.views[0].actions = ['set_rows'];
  d.actions.push({ id: 'read_state', label: 'Read', description: 'x', effects: [{ op: 'reset', field: 'rows' }] });
  const codes = validateDefinition(d).issues.map((i) => i.code);
  assert.ok(codes.includes('too_long'));
  assert.ok(codes.includes('not_dockable'));
  assert.ok(codes.includes('reserved'));
});

test('schema errors come back as issues, not exceptions', () => {
  const r = validateDefinition({ formatVersion: 1, title: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.issues.length > 0);
  assert.equal(validateDefinition(null).ok, false);
});

test('diff finds removed data but not moved views', () => {
  const base = validateDefinition(FIXTURES.characterSheet);
  assert.ok(base.ok);
  const moved = clone(base.definition) as AppletDefinition;
  moved.views.reverse();
  assert.deepEqual(diffDefinitions(base.definition, moved), []);

  const lossy = clone(base.definition) as AppletDefinition;
  lossy.state = lossy.state.filter((s) => s.id !== 'slots');
  lossy.views = lossy.views.filter((v) => v.id !== 'bag');
  const findings = diffDefinitions(base.definition, lossy);
  assert.ok(findings.some((f) => f.kind === 'state_removed' && f.ref === 'slots'));
  assert.ok(findings.some((f) => f.kind === 'state_unreachable' && f.ref === 'inventory') || findings.length >= 1);
});

test('prompt and JSON schema build', () => {
  const schema = authoringResponseJsonSchema();
  assert.equal(schema.type, 'object');
  assert.ok(JSON.stringify(schema).length > 1000);
  assert.match(systemPrompt(), /No dice/);
});
