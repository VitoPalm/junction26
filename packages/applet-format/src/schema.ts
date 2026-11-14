import { z } from 'zod';

/**
 * Applet format v1: the data a model (or a person) writes and our runtime
 * interprets. Data, never code. Views, state and actions are separate lists
 * with stable IDs, so a layout change can't delete user data.
 *
 * Shape decisions (vs. the draft in docs/implementation-plan.md):
 * - Collections are arrays of objects with an `id`, not records keyed by ID.
 *   Models produce arrays more reliably and strict JSON-schema modes reject
 *   free-form records.
 * - Arguments are an array (`args[].name`) for the same reason.
 *
 * Structural rules live here; cross-references, copy budgets and WebMCP name
 * limits are checked in validate.ts.
 */

export const FORMAT_VERSION = 1;
/** Bump when the runtime learns new kinds/ops; definitions declare the minimum they need. */
export const RUNTIME_VERSION = '0.3.0';

/** Copy budgets (code points). Mirrors COPY_LIMITS in packages/glasses-ui. */
export const LIMITS = {
  title: 32,
  label: 28,
  body: 120,
  hint: 48,
  value: 12,
  dockedActions: 2,
  description: 1024,
  argDescription: 256,
  maxViews: 40,
  maxSteps: 80,
  maxStateFields: 40,
  maxActions: 40,
  maxListItems: 200,
  textField: 120,
  /** WebMCP names: 57 usable characters after Meta's prefix. */
  toolName: 57,
} as const;

export const ID = /^[a-z][a-z0-9_]{0,39}$/;
export const PREFIX = /^[a-z][a-z0-9]{1,11}$/;

const id = z.string().regex(ID, 'lowercase letters, digits and _ (start with a letter, at most 40)');
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const argRef = z.object({ arg: z.string().min(1).describe('Name of an argument of this action') }).strict();
const valueExpr = z.union([scalar, argRef]);

// ---------------------------------------------------------------- state

export const ItemField = z
  .object({
    key: id,
    type: z.enum(['string', 'number', 'boolean']),
    label: z.string(),
    /** Used when an append doesn't supply this key. */
    default: scalar.optional(),
    /** Strings only; default 28 (a button label). */
    maxLength: z.number().int().positive().max(LIMITS.textField).optional(),
  })
  .strict();

const stateBase = { id, label: z.string() };

export const StateField = z.discriminatedUnion('type', [
  z
    .object({
      ...stateBase,
      type: z.literal('number'),
      default: z.number(),
      min: z.number().optional(),
      max: z.number().optional(),
      integer: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ ...stateBase, type: z.literal('text'), default: z.string(), maxLength: z.number().int().positive().max(LIMITS.textField) })
    .strict(),
  z.object({ ...stateBase, type: z.literal('boolean'), default: z.boolean() }).strict(),
  z
    .object({
      ...stateBase,
      type: z.literal('list'),
      /** Item shape. Every item also gets a runtime `id`. */
      item: z.array(ItemField).min(1).max(8),
      default: z.array(z.record(z.string(), scalar)).max(LIMITS.maxListItems),
      maxItems: z.number().int().positive().max(LIMITS.maxListItems),
    })
    .strict(),
  /** Position in a sequence view (a guide step). Index into that view's steps. */
  z.object({ ...stateBase, type: z.literal('cursor'), over: id, default: z.number().int().min(0) }).strict(),
]);

// ---------------------------------------------------------------- actions

const match = z
  .object({
    /** Item key to compare; `id` matches the runtime item ID. Strings compare case-insensitively. */
    key: z.string(),
    equals: valueExpr,
  })
  .strict();

export const Op = z.discriminatedUnion('op', [
  /** Add to a number (negative to subtract). Clamped to min/max. */
  z.object({ op: z.literal('add'), field: id, by: z.union([z.number(), argRef]) }).strict(),
  /** Subtract from a number. Clamped to min/max. */
  z.object({ op: z.literal('subtract'), field: id, by: z.union([z.number(), argRef]) }).strict(),
  z.object({ op: z.literal('set'), field: id, value: valueExpr }).strict(),
  z.object({ op: z.literal('toggle'), field: id }).strict(),
  /** Back to the field's default. */
  z.object({ op: z.literal('reset'), field: id }).strict(),
  z.object({ op: z.literal('listAppend'), field: id, item: z.record(z.string(), valueExpr) }).strict(),
  z.object({ op: z.literal('listRemove'), field: id, match }).strict(),
  z.object({ op: z.literal('listUpdate'), field: id, match, set: z.record(z.string(), valueExpr) }).strict(),
  /** Add to a numeric key of the matching item (e.g. quantity). Never below 0 unless the key's default is negative. */
  z.object({ op: z.literal('listAdd'), field: id, match, key: z.string(), by: z.union([z.number(), argRef]) }).strict(),
  z.object({ op: z.literal('listToggle'), field: id, match, key: z.string() }).strict(),
  z.object({ op: z.literal('listClear'), field: id }).strict(),
  /** Step a cursor forward/back within its sequence. */
  z.object({ op: z.literal('move'), field: id, by: z.union([z.literal(1), z.literal(-1)]) }).strict(),
  z.object({ op: z.literal('goto'), view: id }).strict(),
]);

export const ActionArg = z
  .object({
    name: id,
    type: z.enum(['string', 'number', 'integer', 'boolean']),
    description: z.string().max(LIMITS.argDescription),
    required: z.boolean().optional(),
    /** Used when the caller omits the argument (always the case for a docked button). */
    default: scalar.optional(),
  })
  .strict();

export const Action = z
  .object({
    id,
    /** Button text. */
    label: z.string(),
    /** Becomes the WebMCP tool description Meta AI reads. Say when to use it. */
    description: z.string().min(1).max(LIMITS.description),
    args: z.array(ActionArg).max(6).default([]),
    effects: z.array(Op).min(1).max(12),
    /** Example utterances; help the assistant and future generations. */
    examples: z.array(z.string()).max(6).optional(),
  })
  .strict();

// ---------------------------------------------------------------- views

/**
 * Voice note component (docs/voice-notes.md): the wearer can record spoken
 * notes about this page ("Hey Meta, record a note"). The phone records and
 * transcribes them; the glasses only show the recording status and a hint.
 * Notes are not applet state and never change it.
 */
export const VoiceNote = z
  .object({
    /** What the notes are for, shown in the phone app (e.g. "Notes on this step"). */
    label: z.string().optional(),
  })
  .strict();

const viewBase = {
  id,
  /** Optional page heading. Omit when it would only repeat what the content shows. */
  title: z.string().optional(),
  /** Up to two docked buttons. Each action must work with no arguments (defaults). */
  actions: z.array(id).max(LIMITS.dockedActions).optional(),
  /** Adds a voice note component to this page. Sequence views attach notes to the current step. */
  voiceNote: VoiceNote.optional(),
};

export const SequenceStep = z
  .object({
    id,
    title: z.string().optional(),
    text: z.string().optional(),
    hint: z.string().optional(),
    /** Asset ID; image-only steps are complete steps. */
    image: id.optional(),
    alt: z.string().optional(),
  })
  .strict();

export const View = z.discriminatedUnion('kind', [
  z.object({ ...viewBase, kind: z.literal('text'), label: z.string().optional(), text: z.string(), hint: z.string().optional() }).strict(),
  z
    .object({
      ...viewBase,
      kind: z.literal('value'),
      field: id,
      label: z.string().optional(),
      /** Template like "{hp} / {max_hp}"; default shows the field alone. */
      format: z.string().optional(),
      hint: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...viewBase,
      kind: z.literal('list'),
      field: id,
      /** Item key shown as the button label. */
      display: z.string(),
      /** Item key shown underneath (e.g. quantity). Numbers render as "×3". */
      detail: z.string().optional(),
      /** Boolean item key; renders as a checklist where selecting toggles it. */
      check: z.string().optional(),
      /** Action run when an item is selected; receives the item's `display` value as `arg`. */
      onSelect: z.object({ action: id, arg: id }).strict().optional(),
      emptyText: z.string().optional(),
    })
    .strict(),
  z.object({ ...viewBase, kind: z.literal('sequence'), cursor: id, steps: z.array(SequenceStep).min(1).max(LIMITS.maxSteps) }).strict(),
  z.object({ ...viewBase, kind: z.literal('image'), asset: id, alt: z.string() }).strict(),
]);

export const Asset = z
  .object({
    id,
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    /** Source upload (authoring) or inlined data (package). Packaging resolves uploads to data. */
    uploadId: z.string().optional(),
    /** Original source/page for authoring inspection, not task-view copy. */
    source: z.string().max(2000).optional(),
    attribution: z.string().max(2000).optional(),
    data: z.string().optional(),
  })
  .strict();

export const AppletDefinition = z
  .object({
    formatVersion: z.literal(FORMAT_VERSION),
    minimumRuntimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default(RUNTIME_VERSION),
    title: z.string(),
    /** Short, unique per applet: WebMCP tools are named j26_<prefix>_<action>. */
    toolPrefix: z.string().regex(PREFIX, '2-12 lowercase letters/digits, starting with a letter'),
    /** One sentence for the library and for Meta AI ("what is this applet for"). */
    summary: z.string().max(200).optional(),
    state: z.array(StateField).max(LIMITS.maxStateFields),
    actions: z.array(Action).max(LIMITS.maxActions),
    views: z.array(View).min(1).max(LIMITS.maxViews),
    home: z
      .object({
        /** View shown when the applet opens (default: the first). */
        entryView: id.optional(),
        /** Action a pinch on an empty focus should prefer; informational for now. */
        primaryAction: id.optional(),
      })
      .strict()
      .default({}),
    assets: z.array(Asset).max(60).default([]),
  })
  .strict();

export type Scalar = z.infer<typeof scalar>;
export type ArgRef = z.infer<typeof argRef>;
export type ValueExpr = z.infer<typeof valueExpr>;
export type ItemField = z.infer<typeof ItemField>;
export type StateField = z.infer<typeof StateField>;
export type Op = z.infer<typeof Op>;
export type ActionArg = z.infer<typeof ActionArg>;
export type Action = z.infer<typeof Action>;
export type SequenceStep = z.infer<typeof SequenceStep>;
export type View = z.infer<typeof View>;
export type VoiceNote = z.infer<typeof VoiceNote>;
export type Asset = z.infer<typeof Asset>;
export type AppletDefinition = z.infer<typeof AppletDefinition>;
export type ListItem = Record<string, Scalar> & { id: string };

/** JSON Schema of the definition, for model structured output and external tools. */
export function definitionJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AppletDefinition, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}
