import type { AppletDefinition, View } from '@junction26/applet-format';
import type { AppletState } from '@junction26/applet-runtime';
import type { VoiceNoteStatus } from '@junction26/glasses-ui';

/**
 * Where a voice note belongs (docs/voice-notes.md): a view, and on a sequence
 * view the step showing when recording started. IDs, not positions, so notes
 * survive layout changes in later releases.
 */
export interface NoteAnchor {
  viewId: string;
  stepId: string | null;
  /** Human label for the phone app, e.g. "Recipe · Step 3". */
  pageLabel: string;
}

export const anchorKey = (a: Pick<NoteAnchor, 'viewId' | 'stepId'>) => (a.stepId ? `${a.viewId}/${a.stepId}` : a.viewId);

/** The anchor for a view as it is now, or null when that view has no voice note component. */
export function noteAnchor(def: AppletDefinition, state: AppletState, viewId: string | null): NoteAnchor | null {
  const view = def.views.find((v) => v.id === viewId);
  if (!view?.voiceNote) return null;
  const title = view.title ?? def.title;
  if (view.kind !== 'sequence') return { viewId: view.id, stepId: null, pageLabel: title };
  const index = Math.min(Math.max(0, (state.values[view.cursor] as number | undefined) ?? 0), view.steps.length - 1);
  const step = view.steps[index]!;
  return { viewId: view.id, stepId: step.id, pageLabel: `${title} · ${step.title ?? `Step ${index + 1}`}` };
}

export function viewsWithNotes(def: AppletDefinition): View[] {
  return def.views.filter((v) => v.voiceNote);
}

/** What the host knows about notes, for rendering. The host owns recording. */
export interface NotesBinding {
  /** The note in progress, if any (only one at a time per glasses). */
  active: { key: string; status: VoiceNoteStatus; startedAt: number | null; message?: string } | null;
  /** Notes already on the phone, per anchor key. */
  counts: Record<string, number>;
  /** Band pinch on the component: start when idle, stop while recording. */
  toggle(anchor: NoteAnchor): void;
}
