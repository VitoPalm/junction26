import type { Garment } from './care.ts';
import { CARE_KEYS } from './care.ts';
import { classify, dyeRisk, garmentName, type Plan } from './plan.ts';
import { FIELD_NAMES, fieldText } from './symbols.ts';

/**
 * Explanations from confirmed label data and wearer reports, with no AI
 * request. Each line says where it comes from: the manufacturer's label, the
 * wearer, or a general laundry rule of this app.
 */

export interface Explanation { title: string; lines: string[] }

const tag = (from: 'label' | 'wearer' | 'rule') => (from === 'label' ? 'Label' : from === 'wearer' ? 'You said' : 'Rule');

export function explainGarment(plan: Plan, garments: Garment[], id: string): Explanation {
  const g = garments.find((x) => x.id === id);
  const p = plan.placements[id];
  if (!g || !p) return { title: 'Not in this plan', lines: ['That garment isn’t in this laundry session. Add it on your phone with its label.'] };
  const where =
    p.handling === 'machine' ? `Group ${plan.washGroups.find((w) => w.id === p.washGroup)?.number}`
    : p.handling === 'hand' ? 'the hand-wash pile'
    : p.handling === 'professional' ? 'professional cleaning'
    : p.handling === 'do_not_wash' ? 'do not wash'
    : 'check first';
  return { title: `${g.name}: ${where}`, lines: p.reasons.map((r) => `${tag(r.from)}: ${r.text}`) };
}

export function explainGroup(plan: Plan, garments: Garment[], groupId: string): Explanation {
  const w = plan.washGroups.find((x) => x.id === groupId);
  if (!w) {
    const d = plan.dryGroups.find((x) => x.id === groupId);
    if (d) return { title: 'Drying group', lines: [`Rule: grouped by drying instruction, separately from washing. ${d.text}.`, ...d.garmentIds.map((id) => `Label: ${garmentName(garments, id)}: ${fieldText(garments.find((g) => g.id === id)!.label, 'dry')}.`)] };
    return { title: 'Why set aside', lines: plan.review.map((r) => `${garmentName(garments, r.garmentId)}: ${r.reason}`).concat(plan.hand.map((id) => `${garmentName(garments, id)}: hand wash (label).`)) };
  }
  const lines = [`Rule: same cycle (${w.cycle.replace('_', ' ')}), same label temperature (${w.maxTempC}°C) and same colour class (${w.color}).`];
  if (w.alone) lines.push('Rule: washes alone because it may release dye.');
  for (const id of w.garmentIds) lines.push(`Label: ${garmentName(garments, id)}: ${fieldText(garments.find((g) => g.id === id)!.label, 'wash')}.`);
  lines.push('This is a suggestion for your washer; it can’t guarantee no shrinkage or dye transfer.');
  return { title: `Why Group ${w.number}`, lines };
}

/** "Can these go together?": the reasons they can't share a wash, or why they can. */
export function canWashTogether(plan: Plan, garments: Garment[], aId: string, bId: string): Explanation {
  const a = garments.find((g) => g.id === aId), b = garments.find((g) => g.id === bId);
  if (!a || !b) return { title: 'Not in this plan', lines: [`I don’t have ${!a ? aId : bId} in this session. Add it on your phone with its label so I don’t have to guess.`] };
  const pa = plan.placements[a.id]!, pb = plan.placements[b.id]!;
  if (pa.washGroup && pa.washGroup === pb.washGroup) return { title: 'Yes, same group', lines: explainGroup(plan, garments, pa.washGroup).lines };
  const lines: string[] = [];
  const handling = (g: Garment) => classify(g).handling;
  for (const [g, p] of [[a, pa], [b, pb]] as const) lines.push(p.handling !== 'machine' ? `${g.name}: ${p.reasons[0]!.text}` : `${g.name}: ${fieldText(g.label, 'wash')} (label).`);
  if (pa.handling === 'machine' && pb.handling === 'machine') {
    lines.length = 0;
    const wa = a.label.wash.value!, wb = b.label.wash.value!;
    if ((wa.cycle ?? 'normal') !== (wb.cycle ?? 'normal')) lines.push(`Label: different cycles (${a.name}: ${wa.cycle ?? 'normal'}; ${b.name}: ${wb.cycle ?? 'normal'}).`);
    if (wa.maxTempC !== wb.maxTempC) lines.push(`Label: different temperatures (${wa.maxTempC}°C vs ${wb.maxTempC}°C). The lower one alone doesn’t make them compatible.`);
    if (a.info.color !== b.info.color) lines.push(`Rule: different colours (${a.info.color} and ${b.info.color}) can transfer dye.`);
    for (const g of [a, b]) if (dyeRisk(g)) lines.push(`Rule: ${g.name} may release dye (new or not colourfast).`);
  }
  if (!lines.length && handling(a) !== handling(b)) lines.push('They need different handling.');
  return { title: 'No, keep them apart', lines: lines.length ? lines : ['They’re in different groups by the plan’s rules.'] };
}

/** The whole confirmed label, field by field, with what each instruction means. */
export function labelLines(g: Garment): string[] {
  const out = CARE_KEYS.map((k) => `${FIELD_NAMES[k]}: ${fieldText(g.label, k)}${g.label[k].corrected ? ' (you corrected it)' : g.label[k].confirmed ? '' : ' (not confirmed)'}`);
  if (g.info.fibers?.length) out.push(`Fibres: ${g.info.fibers.map((f) => `${f.percent ?? '?'}% ${f.fiber}`).join(', ')}`);
  return out;
}
