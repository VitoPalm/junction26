import type { AppletDefinition, StateField, View } from './schema.ts';

/**
 * Program-detected changes between two revisions. The program decides what was
 * lost; AI may only phrase it. Moving data to another view is not a loss.
 */
export interface ChangeFinding {
  kind: 'state_removed' | 'state_type_changed' | 'list_key_removed' | 'action_removed' | 'state_unreachable';
  /** Stable ID of what changed. */
  ref: string;
  /** Plain words for the change review screen. */
  message: string;
  /** Data loss (needs explicit acceptance) vs. a capability change. */
  severity: 'data_loss' | 'capability';
}

function viewFields(v: View): string[] {
  switch (v.kind) {
    case 'value': {
      const refs = [...(v.format ?? '').matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]!);
      return [v.field, ...refs];
    }
    case 'list':
      return [v.field];
    case 'sequence':
      return [v.cursor];
    default:
      return [];
  }
}

function fieldsTouchedByActions(def: AppletDefinition): Set<string> {
  const s = new Set<string>();
  for (const a of def.actions) for (const op of a.effects) if ('field' in op) s.add(op.field);
  return s;
}

export function diffDefinitions(base: AppletDefinition, next: AppletDefinition): ChangeFinding[] {
  const out: ChangeFinding[] = [];
  const nextFields = new Map(next.state.map((f) => [f.id, f]));
  for (const f of base.state) {
    const n = nextFields.get(f.id);
    if (!n) {
      out.push({ kind: 'state_removed', ref: f.id, severity: 'data_loss', message: `“${f.label}” and everything saved in it would be removed.` });
      continue;
    }
    if (n.type !== f.type) {
      out.push({ kind: 'state_type_changed', ref: f.id, severity: 'data_loss', message: `“${f.label}” changes from a ${f.type} to a ${n.type}; its saved value can't carry over.` });
      continue;
    }
    if (f.type === 'list' && n.type === 'list') {
      for (const k of f.item) {
        if (!n.item.some((x) => x.key === k.key)) {
          out.push({ kind: 'list_key_removed', ref: `${f.id}.${k.key}`, severity: 'data_loss', message: `“${k.label}” would be dropped from every item in “${f.label}”.` });
        }
      }
    }
  }
  // Still stored, but nothing can show or change it any more.
  const visible = new Set(next.views.flatMap(viewFields));
  const touched = fieldsTouchedByActions(next);
  const baseVisible = new Set(base.views.flatMap(viewFields));
  for (const f of next.state as StateField[]) {
    const wasReachable = baseVisible.has(f.id) || fieldsTouchedByActions(base).has(f.id);
    if (base.state.some((b) => b.id === f.id) && wasReachable && !visible.has(f.id) && !touched.has(f.id)) {
      out.push({ kind: 'state_unreachable', ref: f.id, severity: 'data_loss', message: `“${f.label}” is kept but no page or command can reach it any more.` });
    }
  }
  const nextActions = new Set(next.actions.map((a) => a.id));
  for (const a of base.actions) {
    if (!nextActions.has(a.id)) out.push({ kind: 'action_removed', ref: a.id, severity: 'capability', message: `The “${a.label}” command would be removed.` });
  }
  return out;
}
