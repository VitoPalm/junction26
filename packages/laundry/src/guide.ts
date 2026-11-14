import type { Garment } from './care.ts';
import { garmentName, type Plan } from './plan.ts';
import { washText } from './symbols.ts';

/**
 * The accepted plan as one concise action per screen. Step IDs are stable
 * (they name the group, not its position), so progress on unchanged groups
 * survives a plan change. The wearer confirms each step; nothing is assumed
 * about the pile or the washer.
 */
export type StepKind = 'set_aside' | 'sort' | 'wash' | 'dry' | 'complete';

export interface Step {
  id: string;
  kind: StepKind;
  title: string;
  text: string;
  garmentIds: string[];
  /** Wash or dry group this step belongs to. */
  groupId: string | null;
  /** Label of the confirm button. */
  confirm: string;
}

const names = (garments: Garment[], ids: string[]) => ids.map((id) => garmentName(garments, id)).join(', ');

function fit(prefix: string, garments: Garment[], ids: string[], suffix = ''): string {
  const full = `${prefix}${names(garments, ids)}${suffix}`;
  return Array.from(full).length <= 120 ? full : `${prefix}${ids.length} garments (Show garments)${suffix}`;
}

export function planSteps(plan: Plan, garments: Garment[]): Step[] {
  const steps: Step[] = [];
  if (plan.hand.length) steps.push({ id: 'aside_hand', kind: 'set_aside', title: 'Hand wash pile', text: fit('Set aside for hand washing: ', garments, plan.hand), garmentIds: plan.hand, groupId: null, confirm: 'Confirm sorted' });
  if (plan.professional.length) steps.push({ id: 'aside_professional', kind: 'set_aside', title: 'Professional cleaning', text: fit('Keep out of the wash, for professional cleaning: ', garments, plan.professional), garmentIds: plan.professional, groupId: null, confirm: 'Confirm sorted' });
  if (plan.doNotWash.length) steps.push({ id: 'aside_do_not_wash', kind: 'set_aside', title: 'Do not wash', text: fit('Do not wash: ', garments, plan.doNotWash, '. Keep out of the laundry.'), garmentIds: plan.doNotWash, groupId: null, confirm: 'Confirm sorted' });
  if (plan.review.length) steps.push({ id: 'aside_review', kind: 'set_aside', title: 'Check first', text: fit('Set aside to check first: ', garments, plan.review.map((r) => r.garmentId)), garmentIds: plan.review.map((r) => r.garmentId), groupId: null, confirm: 'Confirm sorted' });
  for (const g of plan.washGroups) {
    steps.push({ id: `sort_${g.id}`, kind: 'sort', title: `Group ${g.number} · Sort`, text: fit(`Group ${g.number}: add `, garments, g.garmentIds, g.alone ? ', on its own' : ''), garmentIds: g.garmentIds, groupId: g.id, confirm: 'Confirm sorted' });
    steps.push({ id: `wash_${g.id}`, kind: 'wash', title: `Group ${g.number} · Wash`, text: g.settings.slice(0, 120), garmentIds: g.garmentIds, groupId: g.id, confirm: 'Wash done' });
  }
  if (plan.hand.length) {
    const temps = plan.hand.map((id) => garments.find((g) => g.id === id)!).map((g) => `${g.name}: ${washText(g.label.wash.value!)}`).join('; ');
    steps.push({ id: 'wash_hand', kind: 'wash', title: 'Hand wash', text: Array.from(`Hand wash, following each label. ${temps}`).length <= 120 ? `Hand wash, following each label. ${temps}` : 'Hand wash each garment as its label says (Show label).', garmentIds: plan.hand, groupId: null, confirm: 'Hand wash done' });
  }
  for (const d of plan.dryGroups) steps.push({ id: `dry_${d.id}`, kind: 'dry', title: 'Dry', text: fit(`${d.text}: `, garments, d.garmentIds), garmentIds: d.garmentIds, groupId: d.id, confirm: 'Drying done' });
  steps.push({ id: 'complete', kind: 'complete', title: 'All done', text: 'Every group is done. Items set aside still need their own care.', garmentIds: [], groupId: null, confirm: 'Finish' });
  return steps;
}
