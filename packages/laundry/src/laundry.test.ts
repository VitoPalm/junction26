import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accept, answer, buildPlan, canWashTogether, confirmAll, confirmStep, correctField, decline, DEMO_DATA, DEMO_GARMENTS, emptyLaundry,
  explainSymbol, extractedFor, findGarment, LABEL_FIXTURES, move, normalizeExtraction, parseLaundry, planSteps, report, undo, unconfirmedFields, view,
  type Garment,
} from './index.ts';

const plan = buildPlan(DEMO_GARMENTS);
const group = (id: string) => plan.washGroups.find((w) => w.garmentIds.includes(id));

test('demo data validates and every fixture label file exists in the table', () => {
  assert.ok(parseLaundry(DEMO_DATA).ok);
  assert.equal(new Set(LABEL_FIXTURES.map((f) => f.file)).size, LABEL_FIXTURES.length);
});

test('grouping is conservative: same cycle, same temperature, same colour', () => {
  assert.equal(group('navy_jeans')!.id, group('black_tee')!.id, 'compatible darks share a group');
  assert.notEqual(group('white_towels')!.id, group('white_tee')!.id, '60°C and 40°C whites stay apart');
  assert.notEqual(group('gym_leggings')!.id, group('navy_jeans')!.id, 'delicate 30°C is not merged into normal 40°C');
  assert.equal(group('red_flannel')!.garmentIds.length, 1, 'new bright garment of unknown colourfastness washes alone');
  assert.ok(group('red_flannel')!.alone);
  assert.match(group('navy_jeans')!.settings, /^Suggested \(match on your washer\): Normal, 40°C or lower, do not bleach$/);
});

test('hand-wash, do-not-wash, professional and unreadable items stay out of machine groups', () => {
  assert.deepEqual(plan.hand, ['blue_sweater']);
  assert.deepEqual(plan.professional, ['silk_blouse']);
  assert.deepEqual(plan.review.map((r) => r.garmentId).sort(), ['linen_trousers', 'striped_shirt']);
  for (const id of ['blue_sweater', 'silk_blouse', 'linen_trousers', 'striped_shirt']) assert.equal(plan.placements[id]!.washGroup, null);
  assert.match(plan.review.find((r) => r.garmentId === 'striped_shirt')!.reason, /unreadable.*Conflicting/);
});

test('drying is grouped separately from washing', () => {
  const dry = (id: string) => plan.dryGroups.find((d) => d.garmentIds.includes(id))!;
  assert.equal(dry('navy_jeans').id, dry('white_tee').id, 'different wash groups, same tumble-low drying');
  assert.equal(dry('gym_leggings').method, 'line');
  assert.equal(dry('blue_sweater').method, 'dry_flat');
  assert.equal(dry('white_towels').id, 'd_tumble_medium');
  assert.equal(plan.placements.silk_blouse!.dryGroup, null);
});

test('unconfirmed, missing and stained labels never become permission', () => {
  const raw = extractedFor('navy-jeans.png')!;
  const g: Garment = { id: 'x', name: 'X', labelUploadId: null, thumbnail: null, label: raw.label, info: raw.info };
  assert.deepEqual(unconfirmedFields(g), ['wash', 'bleach', 'dry', 'iron', 'professional']);
  assert.equal(buildPlan([g]).placements.x!.handling, 'review');
  const noWash = correctField(confirmAll(g), 'wash', 'not_present', null);
  assert.equal(buildPlan([noWash]).placements.x!.handling, 'review', 'no washing instruction is not permission to machine wash');
  const stained = { ...confirmAll(g), info: { ...g.info, stained: true } };
  assert.match(buildPlan([stained]).review[0]!.reason, /stained/);
  const unknownColor = { ...confirmAll(g), info: { ...g.info, color: 'unknown' as const } };
  assert.equal(buildPlan([unknownColor]).questions[0]!.ask, 'color');
});

test('the wearer corrects an extraction mistake before planning', () => {
  const raw = extractedFor('grey-hoodie.png')!;
  assert.equal(raw.label.wash.value!.maxTempC, 60, 'fixture extraction misread the temperature');
  const fixed = correctField(confirmAll({ id: 'grey_hoodie', name: 'Grey hoodie', labelUploadId: null, thumbnail: null, label: raw.label, info: raw.info }), 'wash', 'present', { method: 'machine', maxTempC: 40, cycle: 'normal' });
  assert.equal(fixed.label.wash.corrected, true);
  assert.equal(buildPlan([fixed]).washGroups[0]!.maxTempC, 40);
});

test('explanations cite the label and say why garments can or cannot share a wash', () => {
  const towels = canWashTogether(plan, DEMO_GARMENTS, 'blue_sweater', 'white_towels');
  assert.equal(towels.title, 'No, keep them apart');
  assert.ok(towels.lines.some((l) => /Hand wash only, up to 30°C/.test(l)));
  const temps = canWashTogether(plan, DEMO_GARMENTS, 'white_towels', 'white_tee');
  assert.ok(temps.lines.some((l) => /60°C vs 40°C.*lower one alone/.test(l)));
  assert.equal(canWashTogether(plan, DEMO_GARMENTS, 'navy_jeans', 'black_tee').title, 'Yes, same group');
  assert.match(canWashTogether(plan, DEMO_GARMENTS, 'blue_sweater', 'bath_mat').lines[0]!, /don’t have bath_mat/);
  assert.match(explainSymbol('what do two bars under the tub mean')!, /very mild, gentle cycle/);
  assert.match(explainSymbol('a triangle with two lines')!, /non-chlorine/, 'triangle lines are bleach, not cycle bars');
  assert.match(explainSymbol('square with a horizontal line')!, /dry flat/);
  assert.equal(explainSymbol('a spaceship'), null);
  assert.equal(findGarment(DEMO_DATA, 'my towels')!.id, 'white_towels');
  assert.equal(findGarment(DEMO_DATA, 'the sweater')!.id, 'blue_sweater');
});

test('confirmations are explicit, repeat-safe and undoable', () => {
  let s = emptyLaundry();
  const first = view(DEMO_DATA, s).step;
  assert.equal(first.id, 'aside_hand');
  s = confirmStep(DEMO_DATA, s, 'op1');
  assert.deepEqual(s.confirmed, ['aside_hand']);
  assert.equal(confirmStep(DEMO_DATA, s, 'op1'), s, 'same operation ID applies once');
  s = move(DEMO_DATA, s, -1);
  const again = confirmStep(DEMO_DATA, s);
  assert.deepEqual(again.confirmed, ['aside_hand'], 'confirming a confirmed step changes nothing');
  assert.equal(again.undo.length, s.undo.length);
  const meant = view(DEMO_DATA, move(DEMO_DATA, s, 1)).step.id;
  const twice = confirmStep(DEMO_DATA, confirmStep(DEMO_DATA, move(DEMO_DATA, s, 1), undefined, meant), undefined, meant);
  assert.equal(twice.confirmed.length, 2, 'a duplicate aimed at the same step does not confirm the next one');
  s = undo(confirmStep(DEMO_DATA, move(DEMO_DATA, s, 1)));
  assert.deepEqual(s.confirmed, ['aside_hand']);
  s = undo(s);
  assert.deepEqual(s.confirmed, []);
});

test('"this garment is new" asks, proposes, and only changes the plan when accepted', () => {
  const data = { ...DEMO_DATA, garments: DEMO_GARMENTS.map((g) => (g.id === 'black_tee' ? { ...g, info: { ...g.info, color: 'unknown' as const } } : g)) };
  let s = report(data, emptyLaundry(), 'new', { garmentId: 'black_tee', id: 'r1' });
  assert.equal(s.clarify!.question, 'What colour is Black tee?');
  s = answer(data, s, 'Dark or bright');
  assert.ok(s.proposal!.lines.some((l) => /release dye/.test(l)));
  assert.equal(view(data, s).plan.placements.black_tee!.handling, 'review', 'unchanged until accepted');
  s = accept(data, s);
  const v = view(data, s);
  assert.equal(v.plan.washGroups.find((w) => w.garmentIds.includes('black_tee'))!.alone, true);
  assert.equal(s.history.at(-1)!.outcome, 'accepted');
  assert.equal(view(data, undo(s)).plan.placements.black_tee!.handling, 'review', 'undo restores the original plan');
});

test('a plan change after sorting began keeps unchanged progress and history', () => {
  let s = emptyLaundry();
  for (let i = 0; i < 4; i++) s = confirmStep(DEMO_DATA, s); // set-aside steps and Group 1 sort
  const before = [...s.confirmed];
  const leggings = view(DEMO_DATA, s).plan.washGroups.find((w) => w.garmentIds.includes('gym_leggings'))!;
  s = report(DEMO_DATA, s, 'no_cycle', { groupId: leggings.id, id: 'r2' });
  assert.deepEqual(s.clarify!.options, ['A wool or hand-wash program', 'None of these']);
  s = decline(answer(DEMO_DATA, s, 'None of these'));
  assert.equal(s.history.at(-1)!.outcome, 'declined');
  s = report(DEMO_DATA, s, 'no_cycle', { groupId: leggings.id, id: 'r3' });
  s = accept(DEMO_DATA, answer(DEMO_DATA, s, 'None of these'));
  const v = view(DEMO_DATA, s);
  assert.ok(v.plan.hand.includes('gym_leggings'));
  for (const id of before.filter((x) => x !== 'aside_hand')) assert.ok(s.confirmed.includes(id), `${id} kept`);
  assert.ok(!s.confirmed.includes('aside_hand'), 'the hand pile changed, so it needs confirming again');
});

test('"already in the machine" never promises a rescue', () => {
  let s = report(DEMO_DATA, emptyLaundry(), 'in_machine', { garmentId: 'blue_sweater', groupId: group('navy_jeans')!.id, id: 'r4' });
  s = answer(DEMO_DATA, s, 'Yes, it’s running');
  assert.ok(s.proposal!.lines.some((l) => /can’t tell what the cycle will do/.test(l)));
  assert.ok(s.proposal!.lines.some((l) => /care label and your washer’s instructions/.test(l)));
  s = accept(DEMO_DATA, s);
  assert.equal(view(DEMO_DATA, s).plan.placements.blue_sweater!.handling, 'review');
});

test('extraction output is normalized, unconfirmed and fails closed', () => {
  const e = normalizeExtraction({ wash: { status: 'present', value: { method: 'machine', maxTempC: 'hot' }, source: 'x' }, bleach: { status: 'not_present' }, dry: { status: 'bogus' } });
  assert.equal(e.label.wash.status, 'unreadable');
  assert.equal(e.label.bleach.status, 'not_present');
  assert.equal(e.label.dry.status, 'unreadable');
  assert.ok(e.needsClearerImage);
  assert.ok(Object.values(e.label).every((f) => !f.confirmed));
});

test('every step fits the display copy budget', () => {
  for (const s of planSteps(plan, DEMO_GARMENTS)) assert.ok(Array.from(s.text).length <= 120, s.id);
});
