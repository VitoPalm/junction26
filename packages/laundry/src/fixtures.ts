import type { CareLabel, FieldStatus, Garment, GarmentInfo, LaundryData } from './care.ts';

/**
 * Original fixture garments and labels (made up for tests; Apache-2.0 like the
 * repo). Label images live in fixtures/labels/*.png: plain printed text, no
 * symbol artwork. Each garment has:
 * - `extracted`: what extraction returns (unconfirmed), keyed by label file,
 * - `garments`: the same after the wearer reviewed and confirmed them, which
 *   the glasses demo uses.
 * Coverage: compatible machine-wash items (navy jeans + black tee), different
 * temperatures (towels 60°C vs white tee 40°C), hand-wash only (blue
 * sweater), do-not-wash / dry-clean only (silk blouse), tumble vs line vs flat
 * drying, an unreadable label (linen trousers), a conflicting label (striped
 * shirt), a new bright garment of unknown colourfastness (red flannel), and an
 * extraction mistake the wearer corrects (grey hoodie: read 60°C, label says 40°C).
 */

type F<T> = { status: FieldStatus; value: T | null; source: string | null };
const p = <T,>(value: T, source: string): F<T> => ({ status: 'present', value, source });
const np: F<never> = { status: 'not_present', value: null, source: null };
const ur = (source: string): F<never> => ({ status: 'unreadable', value: null, source });

function label(l: { wash: F<CareLabel['wash']['value']>; bleach: F<CareLabel['bleach']['value']>; dry: F<CareLabel['dry']['value']>; iron: F<CareLabel['iron']['value']>; professional: F<CareLabel['professional']['value']> }, confirmed: boolean): CareLabel {
  const c = <T,>(f: F<T>) => ({ ...f, confirmed, corrected: false });
  return { wash: c(l.wash), bleach: c(l.bleach), dry: c(l.dry), iron: c(l.iron), professional: c(l.professional) } as CareLabel;
}

interface Fixture { id: string; name: string; file: string; info: GarmentInfo; read: Parameters<typeof label>[0]; correct?: Partial<Parameters<typeof label>[0]> }

const cotton = (n = 100) => [{ fiber: 'cotton', percent: n }];

export const LABEL_FIXTURES: Fixture[] = [
  { id: 'white_towels', name: 'White towels', file: 'white-towels.png', info: { fibers: cotton(), color: 'white', isNew: false, colorfast: true, stained: false },
    read: { wash: p({ method: 'machine', maxTempC: 60, cycle: 'normal' }, 'Machine wash hot 60°C'), bleach: p('any', 'Bleach as needed'), dry: p({ method: 'tumble', heat: 'medium' }, 'Tumble dry medium'), iron: p('high', 'Iron high'), professional: np } },
  { id: 'white_tee', name: 'White tee', file: 'white-tee.png', info: { fibers: cotton(), color: 'white', isNew: false, colorfast: true, stained: false },
    read: { wash: p({ method: 'machine', maxTempC: 40, cycle: 'normal' }, 'Machine wash warm 40°C'), bleach: p('non_chlorine_only', 'Non-chlorine bleach only'), dry: p({ method: 'tumble', heat: 'low' }, 'Tumble dry low'), iron: p('medium', 'Warm iron'), professional: np } },
  { id: 'navy_jeans', name: 'Navy jeans', file: 'navy-jeans.png', info: { fibers: [{ fiber: 'cotton', percent: 98 }, { fiber: 'elastane', percent: 2 }], color: 'dark', isNew: false, colorfast: null, stained: false },
    read: { wash: p({ method: 'machine', maxTempC: 40, cycle: 'normal' }, 'Machine wash warm 40°C, inside out'), bleach: p('do_not_bleach', 'Do not bleach'), dry: p({ method: 'tumble', heat: 'low' }, 'Tumble dry low'), iron: p('medium', 'Warm iron'), professional: np } },
  { id: 'black_tee', name: 'Black tee', file: 'black-tee.png', info: { fibers: cotton(), color: 'dark', isNew: false, colorfast: null, stained: false },
    read: { wash: p({ method: 'machine', maxTempC: 40, cycle: 'normal' }, 'Machine wash warm 40°C'), bleach: p('non_chlorine_only', 'Non-chlorine bleach only'), dry: p({ method: 'tumble', heat: 'low' }, 'Tumble dry low'), iron: p('low', 'Cool iron'), professional: np } },
  { id: 'blue_sweater', name: 'Blue sweater', file: 'blue-sweater.png', info: { fibers: [{ fiber: 'wool', percent: 100 }], color: 'dark', isNew: false, colorfast: null, stained: false },
    read: { wash: p({ method: 'hand', maxTempC: 30, cycle: null }, 'Hand wash cold, max 30°C'), bleach: p('do_not_bleach', 'Do not bleach'), dry: p({ method: 'dry_flat', heat: null }, 'Dry flat'), iron: p('low', 'Cool iron'), professional: p('dry_clean', 'Can be dry cleaned') } },
  { id: 'silk_blouse', name: 'Silk blouse', file: 'silk-blouse.png', info: { fibers: [{ fiber: 'silk', percent: 100 }], color: 'light', isNew: false, colorfast: null, stained: false },
    read: { wash: p({ method: 'do_not_wash', maxTempC: null, cycle: null }, 'Do not wash'), bleach: p('do_not_bleach', 'Do not bleach'), dry: np, iron: p('low', 'Cool iron'), professional: p('dry_clean_only', 'Dry clean only') } },
  { id: 'gym_leggings', name: 'Gym leggings', file: 'gym-leggings.png', info: { fibers: [{ fiber: 'polyester', percent: 80 }, { fiber: 'elastane', percent: 20 }], color: 'dark', isNew: false, colorfast: null, stained: false },
    read: { wash: p({ method: 'machine', maxTempC: 30, cycle: 'delicate' }, 'Machine wash cold 30°C, gentle cycle'), bleach: p('do_not_bleach', 'Do not bleach'), dry: p({ method: 'line', heat: null }, 'Line dry, do not tumble dry'), iron: p('do_not_iron', 'Do not iron'), professional: p('do_not_dry_clean', 'Do not dry clean') } },
  { id: 'red_flannel', name: 'Red flannel shirt', file: 'red-flannel.png', info: { fibers: cotton(), color: 'bright', isNew: true, colorfast: null, stained: false },
    read: { wash: p({ method: 'machine', maxTempC: 40, cycle: 'normal' }, 'Machine wash warm 40°C, wash separately'), bleach: p('non_chlorine_only', 'Non-chlorine bleach only'), dry: p({ method: 'tumble', heat: 'low' }, 'Tumble dry low'), iron: p('medium', 'Warm iron'), professional: np } },
  { id: 'linen_trousers', name: 'Linen trousers', file: 'linen-trousers.png', info: { fibers: [{ fiber: 'linen', percent: 100 }], color: 'light', isNew: false, colorfast: null, stained: false },
    read: { wash: ur('Washing line smudged: “Machine wash ?0°C”'), bleach: p('do_not_bleach', 'Do not bleach'), dry: p({ method: 'line', heat: null }, 'Line dry'), iron: p('high', 'Hot iron'), professional: np } },
  { id: 'striped_shirt', name: 'Striped shirt', file: 'striped-shirt.png', info: { fibers: cotton(), color: 'light', isNew: false, colorfast: null, stained: false },
    read: { wash: ur('Conflicting: “Machine wash 40°C” and “Hand wash only”'), bleach: p('non_chlorine_only', 'Non-chlorine bleach only'), dry: p({ method: 'tumble', heat: 'low' }, 'Tumble dry low'), iron: p('medium', 'Warm iron'), professional: np } },
  { id: 'grey_hoodie', name: 'Grey hoodie', file: 'grey-hoodie.png', info: { fibers: [{ fiber: 'cotton', percent: 60 }, { fiber: 'polyester', percent: 40 }], color: 'light', isNew: false, colorfast: null, stained: false },
    // Extraction mistake: read as 60°C; the label says 40°C. The wearer corrects it.
    read: { wash: p({ method: 'machine', maxTempC: 60, cycle: 'normal' }, 'Machine wash warm 40°C'), bleach: p('non_chlorine_only', 'Non-chlorine bleach only'), dry: p({ method: 'tumble', heat: 'low' }, 'Tumble dry low'), iron: p('medium', 'Warm iron'), professional: np },
    correct: { wash: p({ method: 'machine', maxTempC: 40, cycle: 'normal' }, 'Machine wash warm 40°C') } },
];

/** Extraction output for a label file (unconfirmed), as the fake model returns it. */
export function extractedFor(file: string): { name: string; label: CareLabel; info: GarmentInfo } | null {
  const f = LABEL_FIXTURES.find((x) => x.file === file);
  return f ? { name: f.name, label: label(f.read, false), info: { ...f.info, isNew: f.info.isNew, colorfast: f.info.colorfast } } : null;
}

/** After review: everything confirmed, the hoodie corrected. */
export function confirmedGarment(f: Fixture): Garment {
  const read = { ...f.read, ...f.correct };
  const l = label(read, true);
  if (f.correct?.wash) l.wash = { ...l.wash, corrected: true };
  return { id: f.id, name: f.name, labelUploadId: null, thumbnail: null, label: l, info: f.info };
}

export const DEMO_GARMENTS: Garment[] = LABEL_FIXTURES.map(confirmedGarment);
export const DEMO_DATA: LaundryData = { region: 'us', garments: DEMO_GARMENTS };

/** A ready-to-open laundry applet for the glasses (bundled example and tests). */
export const laundryDemo = {
  formatVersion: 1 as const,
  title: 'Laundry: Sunday load',
  toolPrefix: 'laundry',
  summary: 'Sorting plan and washing steps from confirmed care labels.',
  state: [],
  actions: [],
  views: [{ id: 'plan', kind: 'text' as const, text: 'Open this on your glasses to follow the laundry plan.' }],
  task: { kind: 'laundry', version: 1, data: DEMO_DATA as unknown as Record<string, unknown> },
};
