import type { CoachState } from './coach.ts';
import type { Action, AppletDefinition, ListItem, Op, Scalar, StateField, ValueExpr, View } from '@junction26/applet-format';

/**
 * Pure applet state machine: `dispatch(definition, state, actionId, args)`
 * returns a new state or a handled error. Shared by the glasses app, the
 * authoring preview and tests; band buttons and WebMCP voice tools both end up
 * here. No I/O, no clocks, no randomness.
 */

export type Values = Record<string, Scalar | ListItem[]>;

export interface AppletState {
  /** Definition revision this state was last migrated to (opaque to the runtime). */
  revision: string | null;
  values: Values;
  /** Values of fields a newer revision no longer has. Kept, never silently deleted. */
  orphaned: Values;
  /** Current view ID. */
  view: string;
  /** Per-list counters for item IDs (stable, deterministic). */
  nextItem: Record<string, number>;
  /** Task coach progress, requests and recovery branch (guides made from a manual). See coach.ts. */
  coach?: CoachState;
}

export type DispatchResult =
  | { ok: true; state: AppletState; summary: string; changed: string[] }
  | { ok: false; code: DispatchErrorCode; message: string };

export type DispatchErrorCode = 'unknown_action' | 'invalid_argument' | 'missing_argument' | 'no_match' | 'list_full' | 'invalid_value';

class Fail extends Error {
  code: DispatchErrorCode;
  constructor(code: DispatchErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function entryView(def: AppletDefinition): string {
  return def.home.entryView ?? def.views[0]!.id;
}

function defaultValue(f: StateField, nextItem: Record<string, number>): Scalar | ListItem[] {
  if (f.type !== 'list') return f.default;
  return f.default.map((raw) => {
    const item: Record<string, Scalar> = {};
    for (const k of f.item) item[k.key] = raw[k.key] ?? k.default ?? emptyOf(k.type);
    const n = (nextItem[f.id] ?? 0) + 1;
    nextItem[f.id] = n;
    return { ...item, id: typeof raw.id === 'string' ? raw.id : `${f.id}_${n}` };
  });
}

const emptyOf = (t: 'string' | 'number' | 'boolean'): Scalar => (t === 'string' ? '' : t === 'number' ? 0 : false);

export function initialState(def: AppletDefinition, revision: string | null = null): AppletState {
  const nextItem: Record<string, number> = {};
  const values: Values = {};
  for (const f of def.state) values[f.id] = defaultValue(f, nextItem);
  return { revision, values, orphaned: {}, view: entryView(def), nextItem };
}

/**
 * Carries state over to a new revision. Same ID and type: kept (clamped to new
 * bounds). New fields: defaults. Fields the new revision dropped or retyped
 * move to `orphaned`, so nothing is lost and a later revision can restore them.
 */
export function migrateState(def: AppletDefinition, prev: AppletState, revision: string | null = null): AppletState {
  const fresh = initialState(def, revision);
  const values: Values = {};
  const orphaned: Values = { ...prev.orphaned };
  const nextItem = { ...fresh.nextItem, ...prev.nextItem };
  const byId = new Map(def.state.map((f) => [f.id, f]));
  for (const f of def.state) {
    const old = prev.values[f.id] ?? prev.orphaned[f.id];
    const carried = old === undefined ? undefined : coerceStored(f, old);
    values[f.id] = carried ?? fresh.values[f.id]!;
    if (carried !== undefined) delete orphaned[f.id];
  }
  for (const [k, v] of Object.entries(prev.values)) {
    const f = byId.get(k);
    if (!f || coerceStored(f, v) === undefined) orphaned[k] = v;
  }
  const view = def.views.some((v) => v.id === prev.view) ? prev.view : entryView(def);
  // Coach progress is never dropped: step IDs that a revision removed stay listed.
  return { revision, values, orphaned, view, nextItem, ...(prev.coach ? { coach: prev.coach } : {}) };
}

function coerceStored(f: StateField, v: Scalar | ListItem[]): Scalar | ListItem[] | undefined {
  switch (f.type) {
    case 'number':
      return typeof v === 'number' ? clamp(f, v) : undefined;
    case 'text':
      return typeof v === 'string' ? Array.from(v).slice(0, f.maxLength).join('') : undefined;
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined;
    case 'cursor':
      return typeof v === 'number' ? Math.max(0, Math.trunc(v)) : undefined;
    case 'list':
      if (!Array.isArray(v)) return undefined;
      // Keep every old key (a dropped key stays on the item, just unused).
      return v.map((item) => {
        const out: ListItem = { ...item };
        for (const k of f.item) if (out[k.key] === undefined || typeof out[k.key] !== k.type) out[k.key] = k.default ?? emptyOf(k.type);
        return out;
      });
  }
}

function clamp(f: Extract<StateField, { type: 'number' }>, n: number): number {
  let v = f.integer ? Math.round(n) : n;
  if (f.min !== undefined) v = Math.max(f.min, v);
  if (f.max !== undefined) v = Math.min(f.max, v);
  return v;
}

/** Arguments arrive from WebMCP as loose JSON (and sometimes as strings). Coerce and validate here. */
function resolveArgs(action: Action, raw: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const a of action.args) {
    let v = raw[a.name];
    if (v === undefined || v === null || v === '') {
      if (a.default !== undefined) v = a.default;
      else if (a.required) throw new Fail('missing_argument', `Say the ${a.name.replace(/_/g, ' ')}.`);
      else continue;
    }
    if (a.type === 'number' || a.type === 'integer') {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
      if (!Number.isFinite(n)) throw new Fail('invalid_argument', `${a.name} must be a number.`);
      if (a.type === 'integer' && !Number.isInteger(n)) throw new Fail('invalid_argument', `${a.name} must be a whole number.`);
      if (Math.abs(n) > 1e9) throw new Fail('invalid_argument', `${a.name} is too large.`);
      out[a.name] = n;
    } else if (a.type === 'boolean') {
      if (typeof v === 'boolean') out[a.name] = v;
      else if (v === 'true' || v === 'false') out[a.name] = v === 'true';
      else throw new Fail('invalid_argument', `${a.name} must be true or false.`);
    } else {
      if (typeof v !== 'string' && typeof v !== 'number') throw new Fail('invalid_argument', `${a.name} must be text.`);
      const s = String(v).trim();
      if (s.length > 200) throw new Fail('invalid_argument', `${a.name} is too long.`);
      out[a.name] = s;
    }
  }
  return out;
}

function evalExpr(e: ValueExpr, args: Record<string, Scalar>): Scalar | undefined {
  return typeof e === 'object' ? args[e.arg] : e;
}

const norm = (v: Scalar | undefined) => (typeof v === 'string' ? v.trim().toLocaleLowerCase() : v);

function findItem(list: ListItem[], key: string, equals: Scalar | undefined): number {
  const want = norm(equals);
  let i = list.findIndex((it) => norm(it[key]) === want);
  // Voice often says less than the full name ("potion" for "Healing potion").
  if (i < 0 && typeof want === 'string' && want.length >= 3) {
    const hits = list.map((it, j) => [j, norm(it[key])] as const).filter(([, v]) => typeof v === 'string' && v.includes(want));
    if (hits.length === 1) i = hits[0]![0];
  }
  return i;
}

export function dispatch(def: AppletDefinition, state: AppletState, actionId: string, rawArgs: Record<string, unknown> = {}): DispatchResult {
  const action = def.actions.find((a) => a.id === actionId);
  if (!action) return { ok: false, code: 'unknown_action', message: `This applet has no "${actionId}" command.` };
  try {
    const args = resolveArgs(action, rawArgs);
    const next: AppletState = { ...state, values: { ...state.values }, nextItem: { ...state.nextItem } };
    const changed = new Set<string>();
    for (const op of action.effects) applyOp(def, next, op, args, changed);
    return { ok: true, state: next, changed: [...changed], summary: summarize(def, next, [...changed]) };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

function field<T extends StateField['type']>(def: AppletDefinition, id: string, type: T): Extract<StateField, { type: T }> {
  const f = def.state.find((s) => s.id === id);
  if (!f || f.type !== type) throw new Fail('invalid_value', `Field ${id} is not a ${type}.`);
  return f as Extract<StateField, { type: T }>;
}

/** Appends and edits must enforce the same item constraints. */
function itemValue(k: Extract<StateField, { type: 'list' }>['item'][number], value: Scalar): Scalar {
  if (k.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Fail('invalid_argument', `${k.label} needs a number.`);
    return n;
  }
  if (k.type === 'boolean') return value === true || value === 'true';
  const text = String(value);
  if (Array.from(text).length > (k.maxLength ?? 28))
    throw new Fail('invalid_argument', `${k.label} can be at most ${k.maxLength ?? 28} characters.`);
  return text;
}

function applyOp(def: AppletDefinition, s: AppletState, op: Op, args: Record<string, Scalar>, changed: Set<string>) {
  const num = (e: number | { arg: string }) => {
    const v = evalExpr(e, args);
    if (typeof v !== 'number') throw new Fail('invalid_argument', 'A number is needed.');
    return v;
  };
  const list = (id: string) => {
    const f = field(def, id, 'list');
    return { f, items: [...((s.values[id] as ListItem[] | undefined) ?? [])] };
  };
  const matchIndex = (items: ListItem[], m: { key: string; equals: ValueExpr }, label: string) => {
    const i = findItem(items, m.key, evalExpr(m.equals, args));
    if (i < 0) throw new Fail('no_match', `There's no "${String(evalExpr(m.equals, args))}" in ${label}.`);
    return i;
  };
  switch (op.op) {
    case 'add':
    case 'subtract': {
      const f = field(def, op.field, 'number');
      const by = num(op.by);
      const cur = s.values[op.field] as number;
      s.values[op.field] = clamp(f, op.op === 'add' ? cur + by : cur - by);
      changed.add(op.field);
      return;
    }
    case 'set': {
      const f = def.state.find((x) => x.id === op.field);
      const v = evalExpr(op.value, args);
      if (!f || v === undefined) throw new Fail('invalid_value', 'Nothing to set.');
      if (f.type === 'number') {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) throw new Fail('invalid_argument', `${f.label} needs a number.`);
        s.values[f.id] = clamp(f, n);
      } else if (f.type === 'text') {
        const t = String(v);
        if (Array.from(t).length > f.maxLength) throw new Fail('invalid_argument', `${f.label} can be at most ${f.maxLength} characters.`);
        s.values[f.id] = t;
      } else if (f.type === 'boolean') {
        s.values[f.id] = v === true || v === 'true';
      } else throw new Fail('invalid_value', `Can't set ${f.label} directly.`);
      changed.add(f.id);
      return;
    }
    case 'toggle':
      field(def, op.field, 'boolean');
      s.values[op.field] = !s.values[op.field];
      changed.add(op.field);
      return;
    case 'reset': {
      const f = def.state.find((x) => x.id === op.field)!;
      s.values[f.id] = defaultValue(f, s.nextItem);
      changed.add(f.id);
      return;
    }
    case 'listAppend': {
      const { f, items } = list(op.field);
      if (items.length >= f.maxItems) throw new Fail('list_full', `${f.label} is full (${f.maxItems} items).`);
      const item: Record<string, Scalar> = {};
      for (const k of f.item) {
        const expr = op.item[k.key];
        let v = expr === undefined ? undefined : evalExpr(expr, args);
        if (v === undefined) v = k.default ?? emptyOf(k.type);
        v = itemValue(k, v);
        item[k.key] = v;
      }
      const n = (s.nextItem[f.id] ?? 0) + 1;
      s.nextItem[f.id] = n;
      items.push({ ...item, id: `${f.id}_${n}` });
      s.values[f.id] = items;
      changed.add(f.id);
      return;
    }
    case 'listRemove': {
      const { f, items } = list(op.field);
      items.splice(matchIndex(items, op.match, f.label), 1);
      s.values[f.id] = items;
      changed.add(f.id);
      return;
    }
    case 'listUpdate':
    case 'listAdd':
    case 'listToggle': {
      const { f, items } = list(op.field);
      const i = matchIndex(items, op.match, f.label);
      const item = { ...items[i]! };
      if (op.op === 'listUpdate') {
        for (const [k, e] of Object.entries(op.set)) {
          const def = f.item.find((x) => x.key === k)!;
          const v = evalExpr(e, args);
          if (v === undefined) continue;
          item[k] = itemValue(def, v);
        }
      } else if (op.op === 'listAdd') {
        const k = f.item.find((x) => x.key === op.key)!;
        const floor = typeof k.default === 'number' && k.default < 0 ? -Infinity : 0;
        item[op.key] = itemValue(k, Math.max(floor, (Number(item[op.key]) || 0) + num(op.by)));
      } else {
        item[op.key] = !item[op.key];
      }
      items[i] = item;
      s.values[f.id] = items;
      changed.add(f.id);
      return;
    }
    case 'listClear':
      list(op.field);
      s.values[op.field] = [];
      changed.add(op.field);
      return;
    case 'move': {
      const f = field(def, op.field, 'cursor');
      const view = def.views.find((v) => v.id === f.over);
      const max = view?.kind === 'sequence' ? view.steps.length - 1 : 0;
      s.values[f.id] = Math.min(max, Math.max(0, (s.values[f.id] as number) + op.by));
      changed.add(f.id);
      return;
    }
    case 'goto':
      s.view = op.view;
      return;
  }
}

// ---------------------------------------------------------------- reading state

export function formatScalar(v: Scalar | ListItem[] | undefined): string {
  if (v === undefined) return '';
  if (Array.isArray(v)) return `${v.length}`;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return v;
}

/** The text a value view shows: its format template, or the field alone. */
export function formatValue(view: Extract<View, { kind: 'value' }>, state: AppletState): string {
  if (!view.format) return formatScalar(state.values[view.field]);
  return view.format.replace(/\{([a-z0-9_]+)\}/g, (_, id: string) => formatScalar(state.values[id]));
}

/** Plain-language snapshot of the state, for the read_state voice tool and summaries. */
export function describeState(def: AppletDefinition, state: AppletState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.state) {
    const v = state.values[f.id];
    if (f.type === 'list') {
      out[f.label] = (v as ListItem[]).map((it) => Object.fromEntries(f.item.map((k) => [k.label, it[k.key]])));
    } else if (f.type === 'cursor') {
      const view = def.views.find((x) => x.id === f.over);
      const total = view?.kind === 'sequence' ? view.steps.length : 0;
      const step = view?.kind === 'sequence' ? view.steps[v as number] : undefined;
      out[f.label] = { step: (v as number) + 1, of: total, text: step?.text ?? step?.title ?? null };
    } else {
      out[f.label] = v;
    }
  }
  return out;
}

function summarize(def: AppletDefinition, state: AppletState, changed: string[]): string {
  if (!changed.length) return 'Done.';
  return changed
    .map((id) => {
      const f = def.state.find((x) => x.id === id)!;
      const v = state.values[id];
      if (f.type === 'list') return `${f.label}: ${(v as ListItem[]).length} items`;
      if (f.type === 'cursor') return `${f.label} ${(v as number) + 1}`;
      return `${f.label}: ${formatScalar(v)}`;
    })
    .join('; ');
}

// ---------------------------------------------------------------- built-ins (no action needed)

/** Previous/Next on a sequence view. Built in so every guide navigates the same way. */
export function stepSequence(def: AppletDefinition, state: AppletState, viewId: string, by: 1 | -1): AppletState {
  const view = def.views.find((v) => v.id === viewId);
  if (view?.kind !== 'sequence') return state;
  const cur = (state.values[view.cursor] as number | undefined) ?? 0;
  const next = Math.min(view.steps.length - 1, Math.max(0, cur + by));
  return next === cur ? state : { ...state, values: { ...state.values, [view.cursor]: next } };
}

export function withView(state: AppletState, viewId: string): AppletState {
  return state.view === viewId ? state : { ...state, view: viewId };
}

export * from './coach.ts';
