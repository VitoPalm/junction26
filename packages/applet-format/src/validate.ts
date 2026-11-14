import { AppletDefinition, LIMITS, RUNTIME_VERSION, type Action, type StateField, type View } from './schema.ts';

export interface Issue {
  /** JSON-ish path, e.g. `views[2].field`. */
  path: string;
  code: string;
  message: string;
}

export type ValidationResult = { ok: true; definition: AppletDefinition; issues: [] } | { ok: false; issues: Issue[] };

/** WebMCP names reserved by the platform (silently rejected if registered). */
const RESERVED_TOOL_NAMES = new Set([
  'openUrl',
  'goBack',
  'goForward',
  'reload',
  'getCurrentUrl',
  'getPageTitle',
  'getPageText',
]);
/** Tools the glasses runtime adds to every applet. */
export const BUILTIN_TOOLS = ['read_state', 'open_view', 'next_step', 'previous_step'] as const;

export function toolName(prefix: string, name: string): string {
  return `j26_${prefix}_${name}`;
}

const len = (s: string) => Array.from(s).length;

/**
 * The full validation pipeline shared by the worker, the authoring preview and
 * the glasses: structure → references → op/field types → copy budgets →
 * WebMCP names. Measured fit is checked by the renderer (fit guard), not here.
 */
export function validateDefinition(input: unknown): ValidationResult {
  const parsed = AppletDefinition.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path:
          i.path
            .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
            .join('')
            .replace(/^\./, '') || '$',
        code: 'schema',
        message: i.message,
      })),
    };
  }
  const def = parsed.data;
  const issues: Issue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const copy = (path: string, text: string | undefined, limit: number, required = false) => {
    if (text === undefined) return;
    if (!text.trim()) {
      if (required) add(path, 'empty', 'Provide non-empty text');
      else add(path, 'empty', 'Omit the property instead of leaving it empty');
      return;
    }
    if (len(text) > limit)
      add(
        path,
        'too_long',
        `At most ${limit} characters (got ${len(text)}). Split the content into another view or step.`,
      );
  };

  const version = (v: string) => v.split('.').map(Number);
  const requested = version(def.minimumRuntimeVersion),
    installed = version(RUNTIME_VERSION);
  const first = requested.findIndex((n, i) => n !== installed[i]);
  if (def.assets.some((a) => a.mediaType === 'image/gif') && requested[0] === 0 && requested[1]! < 2)
    add('minimumRuntimeVersion', 'runtime_version', 'Looping GIF assets require runtime 0.2.0 or newer.');
  if (first >= 0 && requested[first]! > installed[first]!)
    add(
      'minimumRuntimeVersion',
      'runtime_version',
      `Installed runtime is ${RUNTIME_VERSION}; do not require a newer runtime.`,
    );

  // Titles appear as library/menu buttons, so they share the label budget.
  copy('title', def.title, LIMITS.label, true);

  // Unique IDs per namespace.
  const unique = (kind: string, ids: string[]) => {
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (seen.has(id)) add(`${kind}[${i}].id`, 'duplicate_id', `Duplicate ${kind} id "${id}"`);
      seen.add(id);
    });
  };
  unique(
    'state',
    def.state.map((s) => s.id),
  );
  unique(
    'actions',
    def.actions.map((a) => a.id),
  );
  unique(
    'views',
    def.views.map((v) => v.id),
  );
  unique(
    'assets',
    def.assets.map((a) => a.id),
  );

  const fields = new Map(def.state.map((s) => [s.id, s]));
  const actions = new Map(def.actions.map((a) => [a.id, a]));
  const views = new Map(def.views.map((v) => [v.id, v]));
  const assets = new Set(def.assets.map((a) => a.id));

  // ---- state
  def.state.forEach((f, i) => {
    const p = `state[${i}]`;
    copy(`${p}.label`, f.label, LIMITS.label, true);
    if (f.type === 'number') {
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) add(p, 'range', 'min is greater than max');
      if ((f.min !== undefined && f.default < f.min) || (f.max !== undefined && f.default > f.max))
        add(`${p}.default`, 'range', 'default is outside min/max');
      if (f.integer && !Number.isInteger(f.default)) add(`${p}.default`, 'type', 'default must be an integer');
    }
    if (f.type === 'text' && len(f.default) > f.maxLength)
      add(`${p}.default`, 'too_long', 'default is longer than maxLength');
    if (f.type === 'cursor') {
      const v = views.get(f.over);
      if (!v || v.kind !== 'sequence') add(`${p}.over`, 'reference', `"${f.over}" is not a sequence view`);
      else if (f.default >= v.steps.length) add(`${p}.default`, 'range', 'default is past the last step');
    }
    if (f.type === 'list') {
      const keys = new Set<string>();
      f.item.forEach((k, j) => {
        if (k.key === 'id') add(`${p}.item[${j}].key`, 'reserved', '"id" is assigned by the runtime');
        if (keys.has(k.key)) add(`${p}.item[${j}].key`, 'duplicate_id', `Duplicate item key "${k.key}"`);
        keys.add(k.key);
        copy(`${p}.item[${j}].label`, k.label, LIMITS.label, true);
        if (k.default !== undefined && typeof k.default !== (k.type === 'string' ? 'string' : k.type)) {
          add(`${p}.item[${j}].default`, 'type', `default must be a ${k.type}`);
        }
      });
      if (f.default.length > f.maxItems) add(`${p}.default`, 'too_many', 'More default items than maxItems');
      f.default.forEach((item, j) => {
        for (const [k, v] of Object.entries(item)) {
          if (k === 'id') continue;
          const def = f.item.find((x) => x.key === k);
          if (!def) add(`${p}.default[${j}].${k}`, 'reference', `Unknown item key "${k}"`);
          else if (typeof v !== (def.type === 'string' ? 'string' : def.type))
            add(`${p}.default[${j}].${k}`, 'type', `Must be a ${def.type}`);
          else if (typeof v === 'string' && len(v) > (def.maxLength ?? LIMITS.label))
            add(`${p}.default[${j}].${k}`, 'too_long', 'Longer than the key allows');
        }
      });
    }
  });

  // ---- actions
  def.actions.forEach((a, i) => validateAction(a, `actions[${i}]`, fields, views, add, copy));

  // ---- views
  const gifAssets = new Set(def.assets.filter(a => a.mediaType === 'image/gif').map(a => a.id));
  def.views.forEach((v, i) => validateView(v, `views[${i}]`, fields, actions, assets, gifAssets, add, copy));
  if (def.home.entryView && !views.has(def.home.entryView))
    add('home.entryView', 'reference', `No view "${def.home.entryView}"`);
  if (def.home.primaryAction && !actions.has(def.home.primaryAction))
    add('home.primaryAction', 'reference', `No action "${def.home.primaryAction}"`);

  // ---- WebMCP names
  const names = [...def.actions.map((a) => a.id), ...BUILTIN_TOOLS];
  def.actions.forEach((a, i) => {
    if ((BUILTIN_TOOLS as readonly string[]).includes(a.id))
      add(`actions[${i}].id`, 'reserved', `"${a.id}" is a built-in tool`);
  });
  const seen57 = new Map<string, string>();
  for (const n of names) {
    const full = toolName(def.toolPrefix, n);
    if (full.length > LIMITS.toolName)
      add('toolPrefix', 'tool_name', `Tool name ${full} exceeds ${LIMITS.toolName} characters`);
    if (RESERVED_TOOL_NAMES.has(full)) add('toolPrefix', 'tool_name', `${full} is reserved`);
    const k = full.slice(0, LIMITS.toolName);
    if (seen57.has(k) && seen57.get(k) !== n) add('actions', 'tool_name', `Tools ${n} and ${seen57.get(k)} collide`);
    seen57.set(k, n);
  }

  // ---- assets
  def.assets.forEach((a, i) => {
    if (!a.uploadId && !a.data) add(`assets[${i}]`, 'required', 'Give uploadId or data');
  });

  return issues.length ? { ok: false, issues } : { ok: true, definition: def, issues: [] };
}

type Add = (path: string, code: string, message: string) => void;
type Copy = (path: string, text: string | undefined, limit: number, required?: boolean) => void;

function validateAction(
  a: Action,
  p: string,
  fields: Map<string, StateField>,
  views: Map<string, View>,
  add: Add,
  copy: Copy,
) {
  copy(`${p}.label`, a.label, LIMITS.label, true);
  const args = new Map(a.args.map((x) => [x.name, x]));
  if (args.size !== a.args.length) add(`${p}.args`, 'duplicate_id', 'Duplicate argument names');
  const refArg = (path: string, v: unknown, want?: 'number' | 'string' | 'boolean') => {
    if (typeof v !== 'object' || v === null || !('arg' in v)) return;
    const name = (v as { arg: string }).arg;
    const arg = args.get(name);
    if (!arg) return add(path, 'reference', `Action has no argument "${name}"`);
    const t = arg.type === 'integer' ? 'number' : arg.type;
    if (want && t !== want) add(path, 'type', `Argument "${name}" is ${arg.type}; needs ${want}`);
  };
  const needField = (path: string, id: string, types: StateField['type'][]) => {
    const f = fields.get(id);
    if (!f) {
      add(path, 'reference', `No state field "${id}"`);
      return undefined;
    }
    if (!types.includes(f.type))
      add(path, 'type', `"${id}" is a ${f.type} field; this operation needs ${types.join(' or ')}`);
    return f;
  };
  const checkItemKeys = (path: string, f: StateField | undefined, keys: string[], allowId = false) => {
    if (f?.type !== 'list') return;
    for (const k of keys)
      if (!(allowId && k === 'id') && !f.item.some((x) => x.key === k))
        add(path, 'reference', `List "${f.id}" has no item key "${k}"`);
  };
  a.effects.forEach((op, j) => {
    const q = `${p}.effects[${j}]`;
    switch (op.op) {
      case 'add':
      case 'subtract':
        needField(`${q}.field`, op.field, ['number']);
        refArg(`${q}.by`, op.by, 'number');
        break;
      case 'set': {
        const f = needField(`${q}.field`, op.field, ['number', 'text', 'boolean']);
        const want =
          f?.type === 'text'
            ? 'string'
            : f?.type === 'number'
              ? 'number'
              : f?.type === 'boolean'
                ? 'boolean'
                : undefined;
        if (typeof op.value === 'object') refArg(`${q}.value`, op.value, want as 'number');
        else if (want && typeof op.value !== want) add(`${q}.value`, 'type', `Value must be a ${want}`);
        break;
      }
      case 'toggle':
        needField(`${q}.field`, op.field, ['boolean']);
        break;
      case 'reset':
        needField(`${q}.field`, op.field, ['number', 'text', 'boolean', 'list', 'cursor']);
        break;
      case 'listAppend': {
        const f = needField(`${q}.field`, op.field, ['list']);
        checkItemKeys(`${q}.item`, f, Object.keys(op.item));
        Object.entries(op.item).forEach(([k, v]) => refArg(`${q}.item.${k}`, v));
        break;
      }
      case 'listRemove':
      case 'listClear':
      case 'listUpdate':
      case 'listAdd':
      case 'listToggle': {
        const f = needField(`${q}.field`, op.field, ['list']);
        if ('match' in op) {
          checkItemKeys(`${q}.match.key`, f, [op.match.key], true);
          refArg(`${q}.match.equals`, op.match.equals);
        }
        if (op.op === 'listUpdate') {
          checkItemKeys(`${q}.set`, f, Object.keys(op.set));
          Object.entries(op.set).forEach(([k, v]) => refArg(`${q}.set.${k}`, v));
        }
        if (op.op === 'listAdd' || op.op === 'listToggle') {
          checkItemKeys(`${q}.key`, f, [op.key]);
          const k = f?.type === 'list' ? f.item.find((x) => x.key === op.key) : undefined;
          const want = op.op === 'listAdd' ? 'number' : 'boolean';
          if (k && k.type !== want) add(`${q}.key`, 'type', `Item key "${op.key}" must be a ${want}`);
          if (op.op === 'listAdd') refArg(`${q}.by`, op.by, 'number');
        }
        break;
      }
      case 'move':
        needField(`${q}.field`, op.field, ['cursor']);
        break;
      case 'goto':
        if (!views.has(op.view)) add(`${q}.view`, 'reference', `No view "${op.view}"`);
        break;
    }
  });
  a.args.forEach((arg, j) => {
    if (arg.default !== undefined) {
      const t = arg.type === 'integer' ? 'number' : arg.type;
      if (typeof arg.default !== t) add(`${p}.args[${j}].default`, 'type', `Default must be a ${arg.type}`);
    }
  });
}

function validateView(
  v: View,
  p: string,
  fields: Map<string, StateField>,
  actions: Map<string, Action>,
  assets: Set<string>,
  gifAssets: Set<string>,
  add: Add,
  copy: Copy,
) {
  copy(`${p}.title`, v.title, LIMITS.label);
  if ((v.kind === 'sequence' || v.kind === 'list') && v.actions?.length)
    add(
      `${p}.actions`,
      'unsupported_dock',
      'DELETE the actions property from this view only. Keep the actions in the top-level registry for voice. Sequence and list views never render custom dock actions.',
    );
  (v.actions ?? []).forEach((id, j) => {
    const a = actions.get(id);
    if (!a) return add(`${p}.actions[${j}]`, 'reference', `No action "${id}"`);
    const missing = a.args.filter((x) => x.required && x.default === undefined).map((x) => x.name);
    if (missing.length)
      add(
        `${p}.actions[${j}]`,
        'not_dockable',
        `"${id}" needs ${missing.join(', ')}; a button can't supply arguments. Give them defaults or use a separate action.`,
      );
  });
  const field = (id: string, types: StateField['type'][]) => {
    const f = fields.get(id);
    if (!f) add(`${p}.field`, 'reference', `No state field "${id}"`);
    else if (!types.includes(f.type))
      add(`${p}.field`, 'type', `"${id}" is a ${f.type} field; a ${v.kind} view needs ${types.join(' or ')}`);
    return f;
  };
  switch (v.kind) {
    case 'text':
      copy(`${p}.label`, v.label, LIMITS.label);
      copy(`${p}.text`, v.text, LIMITS.body, true);
      copy(`${p}.hint`, v.hint, LIMITS.hint);
      break;
    case 'value': {
      field(v.field, ['number', 'text', 'boolean']);
      copy(`${p}.label`, v.label, LIMITS.label);
      copy(`${p}.hint`, v.hint, LIMITS.hint);
      if (v.format) {
        for (const m of v.format.matchAll(/\{([a-z0-9_]+)\}/g)) {
          const f = fields.get(m[1]!);
          if (!f || f.type === 'list' || f.type === 'cursor')
            add(`${p}.format`, 'reference', `"{${m[1]}}" is not a number/text/boolean field`);
        }
      }
      break;
    }
    case 'list': {
      if (v.check && !v.onSelect)
        add(`${p}.onSelect`, 'not_interactive', 'A checklist needs an onSelect action that toggles its check field.');
      const f = field(v.field, ['list']);
      if (f?.type === 'list') {
        const key = (k: string | undefined, path: string, type?: string) => {
          if (k === undefined) return;
          const def = f.item.find((x) => x.key === k);
          if (!def) add(`${p}.${path}`, 'reference', `List "${f.id}" has no item key "${k}"`);
          else if (type && def.type !== type) add(`${p}.${path}`, 'type', `Item key "${k}" must be a ${type}`);
        };
        key(v.display, 'display', 'string');
        key(v.detail, 'detail');
        key(v.check, 'check', 'boolean');
      }
      if (v.onSelect) {
        const a = actions.get(v.onSelect.action);
        if (!a) add(`${p}.onSelect.action`, 'reference', `No action "${v.onSelect.action}"`);
        else if (!a.args.some((x) => x.name === v.onSelect!.arg))
          add(`${p}.onSelect.arg`, 'reference', `Action "${a.id}" has no argument "${v.onSelect.arg}"`);
      }
      copy(`${p}.emptyText`, v.emptyText, LIMITS.body);
      break;
    }
    case 'sequence': {
      const f = field(v.cursor, ['cursor']);
      if (f?.type === 'cursor' && f.over !== v.id)
        add(`${p}.cursor`, 'reference', `Cursor "${f.id}" belongs to view "${f.over}"`);
      const ids = new Set<string>();
      v.steps.forEach((s, j) => {
        const q = `${p}.steps[${j}]`;
        if (ids.has(s.id)) add(`${q}.id`, 'duplicate_id', `Duplicate step id "${s.id}"`);
        ids.add(s.id);
        if (!s.text && !s.image) add(q, 'empty', 'A step needs text or an image');
        if (s.image && !assets.has(s.image)) add(`${q}.image`, 'reference', `No asset "${s.image}"`);
        if (s.image && s.text && !gifAssets.has(s.image))
          add(q, 'mixed', 'Put a static diagram and its text on separate steps');
        copy(`${q}.title`, s.title, LIMITS.title);
        copy(`${q}.text`, s.text, LIMITS.body);
        copy(`${q}.hint`, s.hint, LIMITS.hint);
      });
      break;
    }
    case 'image':
      if (!assets.has(v.asset)) add(`${p}.asset`, 'reference', `No asset "${v.asset}"`);
      break;
  }
}
