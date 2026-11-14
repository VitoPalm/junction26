import type { Bleach, CareKey, CareLabel, Dry, Iron, Professional, Wash } from './care.ts';

/**
 * Plain-language meanings of care instructions, available offline with no AI
 * request. Text only: no symbol artwork is reproduced.
 *
 * Sources (meanings paraphrased, not copied):
 * - ISO 3758:2023 "Textiles — Care labelling code using symbols" (Europe and
 *   most regions). The symbols are registered trademarks of GINETEX in many
 *   countries; their artwork needs a licence, so it isn't shown.
 * - US: FTC Care Labeling Rule (16 CFR Part 423) and its glossary, and
 *   ASTM D5489 for the US symbol set. The FTC text is a US government work.
 */
export const SYMBOL_SOURCES = {
  iso: 'ISO 3758:2023 care labelling code (meanings paraphrased; symbol artwork not shown, GINETEX trademark)',
  us: 'US FTC Care Labeling Rule, 16 CFR 423, and ASTM D5489 (meanings paraphrased)',
} as const;

const HEAT: Record<NonNullable<Dry['heat']>, string> = { no_heat: 'no heat', low: 'low heat', medium: 'medium heat', high: 'high heat' };

export function washText(w: Wash): string {
  if (w.method === 'do_not_wash') return 'Do not wash in water';
  const temp = w.maxTempC ? `, up to ${w.maxTempC}°C` : '';
  if (w.method === 'hand') return `Hand wash only${temp}`;
  const cycle = w.cycle === 'delicate' ? ' on a gentle/delicate cycle' : w.cycle === 'permanent_press' ? ' on a permanent-press (mild) cycle' : '';
  return `Machine wash${cycle}${temp}`;
}

export function bleachText(b: Bleach): string {
  return b === 'any' ? 'Any bleach may be used' : b === 'non_chlorine_only' ? 'Only non-chlorine (oxygen) bleach' : 'Do not bleach';
}

export function dryText(d: Dry): string {
  switch (d.method) {
    case 'tumble': return `Tumble dry${d.heat ? `, ${HEAT[d.heat]}` : ''}`;
    case 'do_not_tumble': return 'Do not tumble dry';
    case 'line': return 'Line dry (hang to dry)';
    case 'dry_flat': return 'Dry flat';
    case 'drip_dry': return 'Drip dry (hang wet, no wringing)';
  }
}

export function ironText(i: Iron): string {
  return i === 'do_not_iron' ? 'Do not iron' : `Iron at ${i} temperature`;
}

export function professionalText(p: Professional): string {
  return {
    dry_clean: 'Can be dry cleaned',
    dry_clean_only: 'Dry clean only',
    do_not_dry_clean: 'Do not dry clean',
    wet_clean: 'Professional wet clean',
  }[p];
}

/** "Hand wash only, up to 30°C" / "Not on the label" / "Unreadable" for one field. */
export function fieldText(label: CareLabel, key: CareKey): string {
  const f = label[key];
  if (f.status === 'not_present') return 'Not on the label';
  if (f.status === 'unreadable') return 'Unreadable on the label';
  const v = f.value as never;
  switch (key) {
    case 'wash': return washText(v);
    case 'bleach': return bleachText(v);
    case 'dry': return dryText(v);
    case 'iron': return ironText(v);
    case 'professional': return professionalText(v);
  }
}

export const FIELD_NAMES: Record<CareKey, string> = { wash: 'Washing', bleach: 'Bleach', dry: 'Drying', iron: 'Ironing', professional: 'Professional cleaning' };

/**
 * What a symbol/instruction means, for "What does this symbol mean?". Matches
 * a few words against the reference; returns null when it doesn't know.
 */
export function explainSymbol(query: string): string | null {
  const q = query.toLowerCase();
  const table: [RegExp, string][] = [
    [/chlorine|triangle|bleach/, 'A triangle: bleach. Plain: any bleach. Two diagonal lines inside: only non-chlorine bleach. Crossed out: do not bleach.'],
    [/\b(two|2) (bars|lines) (under|below)|delicate|gentle|wool/, 'Two bars under the washtub: a very mild, gentle cycle (low agitation, short spin).'],
    [/\b(one|1|single) (bar|line) (under|below)|permanent press|synthetic/, 'One bar under the washtub: a mild cycle (permanent press), reduced spin.'],
    [/bars? (under|below)/, 'Bars under the washtub mean a milder cycle: one bar mild (permanent press), two bars very mild (gentle).'],
    [/hand ?wash|hand in (the )?(tub|water)/, 'A hand in the washtub: hand wash only, do not machine wash.'],
    [/(cross|x).*(tub|wash)|do not wash/, 'A crossed-out washtub: do not wash in water.'],
    [/dots?.*tumble|tumble.*dots?|tumble/, 'A circle in a square: tumble drying allowed. One dot: low heat; two dots: normal heat. Crossed out: do not tumble dry.'],
    [/dry flat|horizontal/, 'A horizontal line in a square: dry flat.'],
    [/line dry|hang|vertical|drip/, 'A curved or vertical line in a square: line or drip dry.'],
    [/iron/, 'An iron: ironing allowed. Dots show the maximum heat (1 low, 2 medium, 3 high). Crossed out: do not iron.'],
    [/circle|dry clean|professional|letter (p|f|w)/, 'A circle: professional cleaning. Letters tell the cleaner which process; a crossed-out circle means do not dry clean.'],
    [/\d+\s*°?c|temperature|number|degrees/, 'A number in the washtub: the highest water temperature in °C. Dots are used instead in some regions (1 dot about 30°C).'],
  ];
  return table.find(([re]) => re.test(q))?.[1] ?? null;
}
