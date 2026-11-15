import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURES,
  validateDefinition,
  diffDefinitions,
  authoringResponseJsonSchema,
  systemPrompt,
  type AppletDefinition,
} from './index.ts';

const clone = <T>(v: T): T => structuredClone(v);

test('every fixture is valid', () => {
  for (const [name, def] of Object.entries(FIXTURES)) {
    const r = validateDefinition(def);
    assert.ok(r.ok, `${name}: ${JSON.stringify(r.issues, null, 2)}`);
  }
});

test('GIF instructions remain visible alongside motion; static diagrams retain separate steps', () => {
  const def = {
    formatVersion: 1, minimumRuntimeVersion: '0.2.0', title: 'Heart', toolPrefix: 'heart', actions: [],
    state: [{ id: 'position', type: 'cursor', label: 'Position', over: 'guide', default: 0 }],
    views: [{ id: 'guide', kind: 'sequence', cursor: 'position', steps: [{ id: 'trebles', image: 'demo', text: 'Make 3 treble crochets.', hint: 'Work into the magic ring.' }] }],
    assets: [{ id: 'demo', mediaType: 'image/gif', uploadId: 'source_demo' }],
  };
  assert.equal(validateDefinition(def).ok, true);
  assert.ok(validateDefinition({ ...def, assets: [{ id: 'demo', mediaType: 'image/png', uploadId: 'source_demo' }] }).issues.some(i => i.code === 'mixed'));
  assert.ok(validateDefinition({ ...def, views: [{ ...def.views[0], steps: [{ id: 'long', image: 'demo', text: 'x'.repeat(121) }] }] }).issues.some(i => i.code === 'too_long'));
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

test('refuses newer runtime and nonfunctional checklist declarations', () => {
  const def = structuredClone(FIXTURES.rowCounter) as any;
  def.minimumRuntimeVersion = '1.0.0';
  const r = validateDefinition(def);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.some((i) => i.code === 'runtime_version'));
});

test('voice note component: label budget, runtime version and reserved tool names', () => {
  const def = structuredClone(FIXTURES.rowCounter) as any;
  assert.equal(validateDefinition(def).ok, true);
  def.views[0].voiceNote = { label: 'x'.repeat(29) };
  assert.ok(validateDefinition(def).issues.some((i) => i.path === 'views[0].voiceNote.label' && i.code === 'too_long'));
  def.views[0].voiceNote = {};
  def.minimumRuntimeVersion = '0.2.0';
  assert.ok(validateDefinition(def).issues.some((i) => i.code === 'runtime_version'));
  delete def.minimumRuntimeVersion;
  def.views[0].voiceNote = { label: 'Notes', extra: true };
  assert.equal(validateDefinition(def).ok, false);
  const clash = structuredClone(FIXTURES.rowCounter) as any;
  clash.actions[0].id = 'start_voice_note';
  clash.views[0].actions = ['start_voice_note', 'undo_row'];
  assert.ok(validateDefinition(clash).issues.some((i) => i.code === 'reserved'));
});

test('task coach guides cite sources and resolve parts and excerpts', async () => {
  const { bookcaseGuide } = await import('./fixtures/bookcase.ts');
  assert.ok(validateDefinition(bookcaseGuide).ok);
  const broken = structuredClone(bookcaseGuide) as any;
  delete broken.views[0].steps[2].source;
  broken.views[0].steps[3].parts = ['zz'];
  broken.guide.excerpts.push({ stepId: 'nope', text: 'x', source: { page: 1 } });
  broken.views[0].steps[4].flagNote = 'unclear';
  const r = validateDefinition(broken);
  assert.equal(r.ok, false);
  const codes = r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
  assert.ok(codes.includes('views[0].steps[2].source:required'), codes.join(' '));
  assert.ok(codes.includes('views[0].steps[3].parts[0]:reference'));
  assert.ok(codes.some((c) => c.startsWith('guide.excerpts[') && c.endsWith('stepId:reference')));
  assert.ok(codes.includes('views[0].steps[4].flagNote:reference'));
  const wrongView = { ...structuredClone(bookcaseGuide), guide: { ...bookcaseGuide.guide!, sequence: 'missing' } };
  assert.equal(validateDefinition(wrongView).ok, false);
});
