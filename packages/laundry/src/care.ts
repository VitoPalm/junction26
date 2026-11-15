import { z } from 'zod';

/**
 * Care-label model. Every instruction records what the label shows:
 * - `present`: read from the label (value set),
 * - `not_present`: the label has no such instruction (never permission),
 * - `unreadable`: something is there but couldn't be read, or it conflicts,
 * plus whether the wearer confirmed it. Nothing unconfirmed reaches a plan.
 * Garment information (fibres, colour, new, colourfast, stains) is kept
 * apart from care instructions: it's what the wearer knows, not the label.
 */

export const FieldStatus = z.enum(['present', 'not_present', 'unreadable']);
export type FieldStatus = z.infer<typeof FieldStatus>;

const field = <T extends z.ZodType>(value: T) =>
  z
    .object({
      status: FieldStatus,
      value: value.nullable(),
      /** What the label shows, as read (text or symbol description): the source of this instruction. */
      source: z.string().max(200).nullable(),
      confirmed: z.boolean(),
      /** Changed by the wearer after extraction. */
      corrected: z.boolean().default(false),
    })
    .strict();

export const Wash = z.object({
  method: z.enum(['machine', 'hand', 'do_not_wash']),
  /** Highest water temperature on the label, °C. */
  maxTempC: z.number().int().min(20).max(95).nullable(),
  /** Machine cycle the label allows: normal, permanent press (one bar), gentle/delicate (two bars). */
  cycle: z.enum(['normal', 'permanent_press', 'delicate']).nullable(),
}).strict();
export const Bleach = z.enum(['any', 'non_chlorine_only', 'do_not_bleach']);
export const Dry = z.object({
  method: z.enum(['tumble', 'do_not_tumble', 'line', 'dry_flat', 'drip_dry']),
  heat: z.enum(['no_heat', 'low', 'medium', 'high']).nullable(),
}).strict();
export const Iron = z.enum(['low', 'medium', 'high', 'do_not_iron']);
export const Professional = z.enum(['dry_clean', 'dry_clean_only', 'do_not_dry_clean', 'wet_clean']);

export const CareLabel = z.object({
  wash: field(Wash),
  bleach: field(Bleach),
  dry: field(Dry),
  iron: field(Iron),
  professional: field(Professional),
}).strict();

export const ColorClass = z.enum(['white', 'light', 'dark', 'bright', 'unknown']);

export const GarmentInfo = z.object({
  /** From the label's composition line, kept separate from care instructions. */
  fibers: z.array(z.object({ fiber: z.string().max(40), percent: z.number().min(0).max(100).nullable() }).strict()).max(6).nullable(),
  color: ColorClass,
  /** Not washed before. null = not asked yet. */
  isNew: z.boolean().nullable(),
  /** Known not to bleed dye. null = unknown. */
  colorfast: z.boolean().nullable(),
  /** Flags the garment for separate review; this MVP gives no stain treatment. */
  stained: z.boolean(),
}).strict();

export const Garment = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  name: z.string().min(1).max(28),
  /** Original label photo (kept server-side); the package carries only a thumbnail. */
  labelUploadId: z.string().nullable(),
  /** Asset ID of the small thumbnail in the definition, if any. */
  thumbnail: z.string().nullable(),
  label: CareLabel,
  info: GarmentInfo,
}).strict();

export const LaundryData = z.object({
  /** Care-symbol system the labels were read against. */
  region: z.enum(['iso', 'us']),
  garments: z.array(Garment).min(1).max(40),
}).strict();

export type Wash = z.infer<typeof Wash>;
export type Dry = z.infer<typeof Dry>;
export type Bleach = z.infer<typeof Bleach>;
export type Iron = z.infer<typeof Iron>;
export type Professional = z.infer<typeof Professional>;
export type CareLabel = z.infer<typeof CareLabel>;
export type CareKey = keyof CareLabel;
export type ColorClass = z.infer<typeof ColorClass>;
export type GarmentInfo = z.infer<typeof GarmentInfo>;
export type Garment = z.infer<typeof Garment>;
export type LaundryData = z.infer<typeof LaundryData>;

export const CARE_KEYS: CareKey[] = ['wash', 'bleach', 'dry', 'iron', 'professional'];

/** An unconfirmed field: what extraction produces before the wearer reviews it. */
export function unconfirmed<T>(status: FieldStatus, value: T | null, source: string | null) {
  return { status, value: status === 'present' ? value : null, source, confirmed: false, corrected: false };
}

/** Fields that still need the wearer: anything not confirmed. */
export function unconfirmedFields(g: Garment): CareKey[] {
  return CARE_KEYS.filter((k) => !g.label[k].confirmed);
}

/** Confirms every field as shown (wearer reviewed it). */
export function confirmAll(g: Garment): Garment {
  const label = { ...g.label } as Record<CareKey, CareLabel[CareKey]>;
  for (const k of CARE_KEYS) label[k] = { ...label[k], confirmed: true };
  return { ...g, label: label as CareLabel };
}

/** The wearer corrects a field (manual entry). The correction counts as confirmed. */
export function correctField<K extends CareKey>(g: Garment, key: K, status: FieldStatus, value: CareLabel[K]['value']): Garment {
  const prev = g.label[key];
  return { ...g, label: { ...g.label, [key]: { status, value: status === 'present' ? value : null, source: prev.source, confirmed: true, corrected: true } } };
}

export function parseLaundry(data: unknown): { ok: true; data: LaundryData } | { ok: false; message: string } {
  const r = LaundryData.safeParse(data);
  if (!r.success) return { ok: false, message: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('; ') };
  const ids = new Set<string>();
  for (const g of r.data.garments) {
    if (ids.has(g.id)) return { ok: false, message: `Duplicate garment id ${g.id}` };
    ids.add(g.id);
  }
  return { ok: true, data: r.data };
}
