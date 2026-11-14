import type { Bleach, ColorClass, Dry, Garment, Wash } from './care.ts';
import { CARE_KEYS } from './care.ts';
import { bleachText, dryText, washText } from './symbols.ts';

/**
 * Rule-based sorting plan. This, not a model, makes every grouping decision,
 * and it only uses confirmed label instructions plus what the wearer said.
 * Conservative by design:
 * - Machine-wash groups need the same cycle, the same label temperature and
 *   the same colour class. Picking the lowest temperature is not enough to
 *   combine garments.
 * - New dark or bright garments of unknown colourfastness wash alone.
 * - Hand-wash, do-not-wash and professional-cleaning items never enter a
 *   machine group; unconfirmed, unreadable, missing or stained items go to
 *   review. A missing instruction is never treated as permission.
 * - Drying is grouped separately from washing.
 * Washer settings are suggestions for the wearer to match on their machine.
 */

export type Handling = 'machine' | 'hand' | 'professional' | 'do_not_wash' | 'review';

/** A wearer report or decision applied on top of the confirmed garments. */
export interface Override {
  garmentId: string;
  isNew?: boolean;
  colorfast?: boolean | null;
  color?: ColorClass;
  /** Wash this garment on its own. */
  alone?: boolean;
  /** Washer lacks the needed cycle: hand wash instead (the label allows gentler, never harsher). */
  handWash?: boolean;
  /** Went into an unsuitable cycle: check it after washing, follow its label. */
  checkAfterWash?: boolean;
  /** Washer's own gentle program to use instead of the label's cycle name. */
  cycleName?: string;
}

export interface Reason { text: string; from: 'label' | 'wearer' | 'rule' }

export interface WashGroup {
  id: string;
  number: number;
  garmentIds: string[];
  cycle: NonNullable<Wash['cycle']>;
  maxTempC: number;
  color: ColorClass;
  bleach: Bleach;
  alone: boolean;
  /** Clearly a suggestion: we don't know or control the washer. */
  settings: string;
}

export interface DryGroup {
  id: string;
  method: Dry['method'] | 'unknown';
  heat: Dry['heat'];
  garmentIds: string[];
  text: string;
}

export interface Placement { garmentId: string; handling: Handling; washGroup: string | null; dryGroup: string | null; reasons: Reason[] }

export interface MissingInfo { garmentId: string; ask: 'color' | 'isNew' | 'colorfast' | 'label'; question: string }

export interface Plan {
  washGroups: WashGroup[];
  dryGroups: DryGroup[];
  hand: string[];
  professional: string[];
  doNotWash: string[];
  review: { garmentId: string; reason: string }[];
  placements: Record<string, Placement>;
  questions: MissingInfo[];
}

const COLOR_ORDER: ColorClass[] = ['white', 'light', 'bright', 'dark', 'unknown'];
const BLEACH_RANK: Record<Bleach, number> = { any: 0, non_chlorine_only: 1, do_not_bleach: 2 };
const COLOR_NAME: Record<ColorClass, string> = { white: 'whites', light: 'lights', bright: 'brights', dark: 'darks', unknown: 'unknown colour' };
const CYCLE_NAME = { normal: 'Normal', permanent_press: 'Permanent press', delicate: 'Delicate/gentle' } as const;

export function applyOverrides(garments: Garment[], overrides: Override[]): { garments: Garment[]; flags: Map<string, Override> } {
  const flags = new Map<string, Override>();
  for (const o of overrides) flags.set(o.garmentId, { ...flags.get(o.garmentId), ...o });
  return {
    flags,
    garments: garments.map((g) => {
      const o = flags.get(g.id);
      if (!o) return g;
      return {
        ...g,
        info: {
          ...g.info,
          ...(o.isNew !== undefined ? { isNew: o.isNew } : {}),
          ...(o.colorfast !== undefined ? { colorfast: o.colorfast } : {}),
          ...(o.color !== undefined ? { color: o.color } : {}),
        },
      };
    }),
  };
}

/** Dark or bright, new, and not known to be colourfast: may release dye. */
export function dyeRisk(g: Garment): boolean {
  return (g.info.color === 'dark' || g.info.color === 'bright') && (g.info.colorfast === false || (g.info.isNew === true && g.info.colorfast !== true));
}

function src(g: Garment, key: 'wash' | 'dry' | 'bleach' | 'professional'): string {
  const s = g.label[key].source;
  return s ? ` (label: “${s}”)` : '';
}

/** Where a garment goes before grouping, with the rule that put it there. */
export function classify(g: Garment, o?: Override): { handling: Handling; reason: Reason } {
  const missing = CARE_KEYS.filter((k) => !g.label[k].confirmed);
  if (missing.length) return { handling: 'review', reason: { text: `Its label isn’t confirmed yet (${missing.join(', ')}).`, from: 'rule' } };
  if (o?.checkAfterWash) return { handling: 'review', reason: { text: 'It went into a cycle its label doesn’t allow: check it and follow its label.', from: 'wearer' } };
  if (g.info.stained) return { handling: 'review', reason: { text: 'Marked as stained: review it separately (no stain treatment here).', from: 'wearer' } };
  const w = g.label.wash;
  const p = g.label.professional;
  if (w.status === 'unreadable') return { handling: 'review', reason: { text: `The washing instruction is unreadable${src(g, 'wash')}. Retake the photo or enter it.`, from: 'label' } };
  if (w.status === 'not_present' || !w.value) {
    if (p.status === 'present' && (p.value === 'dry_clean' || p.value === 'dry_clean_only' || p.value === 'wet_clean'))
      return { handling: 'professional', reason: { text: `No washing instruction; the label says professional cleaning${src(g, 'professional')}.`, from: 'label' } };
    return { handling: 'review', reason: { text: 'The label has no washing instruction. Missing isn’t permission: check with the maker.', from: 'rule' } };
  }
  if (p.status === 'present' && p.value === 'dry_clean_only') return { handling: 'professional', reason: { text: `Dry clean only${src(g, 'professional')}.`, from: 'label' } };
  if (w.value.method === 'do_not_wash') {
    return p.status === 'present' && p.value !== 'do_not_dry_clean'
      ? { handling: 'professional', reason: { text: `Do not wash; professional cleaning instead${src(g, 'wash')}.`, from: 'label' } }
      : { handling: 'do_not_wash', reason: { text: `Do not wash${src(g, 'wash')}.`, from: 'label' } };
  }
  if (w.value.method === 'hand') return { handling: 'hand', reason: { text: `${washText(w.value)}${src(g, 'wash')}.`, from: 'label' } };
  if (o?.handWash) return { handling: 'hand', reason: { text: 'Your washer lacks the cycle its label needs, so hand wash it (gentler than the label allows).', from: 'wearer' } };
  if (w.value.maxTempC === null) return { handling: 'review', reason: { text: 'The label gives no washing temperature. Enter it from the label.', from: 'rule' } };
  if (g.info.color === 'unknown') return { handling: 'review', reason: { text: 'Tell me its colour (white, light, bright or dark) to group it.', from: 'rule' } };
  return { handling: 'machine', reason: { text: `${washText(w.value)}${src(g, 'wash')}.`, from: 'label' } };
}

function dryGroupOf(g: Garment): { key: string; method: DryGroup['method']; heat: Dry['heat']; text: string } {
  const d = g.label.dry;
  if (d.status !== 'present' || !d.value) return { key: 'unknown', method: 'unknown', heat: null, text: 'No drying instruction: don’t tumble dry; check the garment' };
  if (d.value.method === 'tumble') return d.value.heat ? { key: `tumble_${d.value.heat}`, method: 'tumble', heat: d.value.heat, text: dryText(d.value) } : { key: 'tumble_unspecified', method: 'tumble', heat: null, text: 'Tumble dry (heat not on label; low is the cautious choice)' };
  return { key: d.value.method, method: d.value.method, heat: null, text: dryText(d.value) };
}

export function buildPlan(confirmed: Garment[], overrides: Override[] = []): Plan {
  const { garments, flags } = applyOverrides(confirmed, overrides);
  const placements: Record<string, Placement> = {};
  const plan: Plan = { washGroups: [], dryGroups: [], hand: [], professional: [], doNotWash: [], review: [], placements, questions: [] };
  const machine = new Map<string, Garment[]>();

  for (const g of garments) {
    const o = flags.get(g.id);
    const c = classify(g, o);
    placements[g.id] = { garmentId: g.id, handling: c.handling, washGroup: null, dryGroup: null, reasons: [c.reason] };
    if (c.handling === 'review') plan.review.push({ garmentId: g.id, reason: c.reason.text });
    else if (c.handling === 'hand') plan.hand.push(g.id);
    else if (c.handling === 'professional') plan.professional.push(g.id);
    else if (c.handling === 'do_not_wash') plan.doNotWash.push(g.id);
    else {
      const w = g.label.wash.value!;
      const alone = !!o?.alone || dyeRisk(g);
      const key = `${w.cycle ?? 'normal'}_${w.maxTempC}_${g.info.color}${alone ? `_${g.id}` : ''}`;
      if (alone) placements[g.id]!.reasons.push({ text: g.info.colorfast === false ? 'It isn’t colourfast, so it washes alone.' : 'New dark or bright garment with unknown colourfastness: wash alone the first time.', from: o?.alone ? 'wearer' : 'rule' });
      machine.set(key, [...(machine.get(key) ?? []), g]);
    }
    // Missing information worth asking about (never assumed).
    if (g.info.color === 'unknown' && c.handling !== 'professional' && c.handling !== 'do_not_wash') plan.questions.push({ garmentId: g.id, ask: 'color', question: `What colour is ${g.name}: white, light, bright or dark?` });
    else if ((g.info.color === 'dark' || g.info.color === 'bright') && g.info.isNew === null && c.handling === 'machine') plan.questions.push({ garmentId: g.id, ask: 'isNew', question: `Is ${g.name} new (never washed)?` });
    else if (g.info.isNew && (g.info.color === 'dark' || g.info.color === 'bright') && g.info.colorfast === null && c.handling === 'machine') plan.questions.push({ garmentId: g.id, ask: 'colorfast', question: `Do you know if ${g.name} is colourfast?` });
    if (g.label.wash.status === 'unreadable') plan.questions.push({ garmentId: g.id, ask: 'label', question: `Retake ${g.name}’s label photo or enter its washing instruction.` });
  }

  const groups = [...machine.entries()].sort(([, a], [, b]) => {
    const wa = a[0]!.label.wash.value!, wb = b[0]!.label.wash.value!;
    return COLOR_ORDER.indexOf(a[0]!.info.color) - COLOR_ORDER.indexOf(b[0]!.info.color) || (wb.maxTempC ?? 0) - (wa.maxTempC ?? 0) || String(wa.cycle).localeCompare(String(wb.cycle)) || a[0]!.id.localeCompare(b[0]!.id);
  });
  groups.forEach(([key, members], i) => {
    const w = members[0]!.label.wash.value!;
    const bleach = members.map((m) => (m.label.bleach.status === 'present' ? m.label.bleach.value! : 'do_not_bleach')).reduce((a, b) => (BLEACH_RANK[b] > BLEACH_RANK[a] ? b : a), 'any' as Bleach);
    const cycleName = members.map((m) => flags.get(m.id)?.cycleName).find(Boolean);
    const id = `w_${key}`;
    const alone = members.length === 1 && key.endsWith(`_${members[0]!.id}`);
    const group: WashGroup = {
      id, number: i + 1, garmentIds: members.map((m) => m.id), cycle: w.cycle ?? 'normal', maxTempC: w.maxTempC!, color: members[0]!.info.color, bleach, alone,
      settings: `Suggested (match on your washer): ${cycleName ?? CYCLE_NAME[w.cycle ?? 'normal']}, ${w.maxTempC}°C or lower, ${bleach === 'any' ? 'bleach allowed' : bleachText(bleach).toLowerCase()}`,
    };
    plan.washGroups.push(group);
    for (const m of members) {
      placements[m.id]!.washGroup = id;
      placements[m.id]!.reasons.push({ text: `Group ${group.number}: ${CYCLE_NAME[group.cycle].toLowerCase()} cycle at ${group.maxTempC}°C with other ${COLOR_NAME[group.color]}.`, from: 'rule' });
    }
  });

  // Drying, grouped on its own: everything that gets washed (machine or hand).
  const dry = new Map<string, { g: ReturnType<typeof dryGroupOf>; ids: string[] }>();
  for (const g of garments) {
    const h = placements[g.id]!.handling;
    if (h !== 'machine' && h !== 'hand') continue;
    const d = dryGroupOf(g);
    const e = dry.get(d.key) ?? { g: d, ids: [] };
    e.ids.push(g.id);
    dry.set(d.key, e);
  }
  const DRY_ORDER = ['tumble_high', 'tumble_medium', 'tumble_low', 'tumble_no_heat', 'tumble_unspecified', 'line', 'drip_dry', 'dry_flat', 'do_not_tumble', 'unknown'];
  for (const [key, e] of [...dry.entries()].sort(([a], [b]) => DRY_ORDER.indexOf(a) - DRY_ORDER.indexOf(b))) {
    const id = `d_${key}`;
    plan.dryGroups.push({ id, method: e.g.method, heat: e.g.heat, garmentIds: e.ids, text: e.g.text });
    for (const gid of e.ids) placements[gid]!.dryGroup = id;
  }
  return plan;
}

export function garmentName(garments: Garment[], id: string): string {
  return garments.find((g) => g.id === id)?.name ?? id;
}
