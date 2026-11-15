import type { ComponentType } from 'react';
import type { AppletDefinition } from '@junction26/applet-format';
import type { AppletSession } from './session.ts';
import type { ToolDef, ToolHost } from './webmcp.ts';

/**
 * Task modules: task-specific screens and voice tools (laundry today; crochet,
 * repair, practice or plant care later) plug into the shared engine here, so
 * the renderer never imports task content. A definition opts in with
 * `task: { kind, version, data }`; the module validates `data`, keeps its
 * progress in `AppletState.task`, and changes it only through
 * `session.update` (persisted before acknowledged).
 */
export interface TaskModule {
  kind: string;
  /** Highest `task.version` this module understands. */
  version: number;
  Screen: ComponentType<{ session: AppletSession }>;
  /** Voice tools for the open task; `t` adds the applet's tool prefix. Every tool needs a manual path in Screen. */
  tools?(def: AppletDefinition, host: ToolHost, t: (name: string) => string, about: string): ToolDef[];
}

const modules = new Map<string, TaskModule>();

export function registerTaskModule(m: TaskModule): void {
  modules.set(m.kind, m);
}

/** The module for a definition's task, if registered and new enough. */
export function taskModule(def: AppletDefinition): TaskModule | null {
  const t = def.task;
  if (!t) return null;
  const m = modules.get(t.kind);
  return m && t.version <= m.version ? m : null;
}
