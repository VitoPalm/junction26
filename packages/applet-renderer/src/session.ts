import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppletDefinition } from '@junction26/applet-format';
import { dispatch, stepSequence, withView, type AppletState, type DispatchResult } from '@junction26/applet-runtime';

export interface AppletSession {
  definition: AppletDefinition;
  state: AppletState;
  /** Runs an action. Resolves after the new state is persisted (an action isn't done until it's saved). */
  run(actionId: string, args?: Record<string, unknown>): Promise<DispatchResult>;
  step(viewId: string, by: 1 | -1): Promise<void>;
  /**
   * Applies a pure state transition (task coach), serialized with actions and
   * persisted before it resolves. Resolves with the committed state.
   */
  update(fn: (state: AppletState) => AppletState): Promise<AppletState>;
  /** Remembers the current view so reopening resumes there. */
  setView(viewId: string): void;
  /** Last handled error, for a brief on-screen notice. */
  notice: string | null;
  clearNotice(): void;
}

/**
 * Owns one open applet's state. Every change goes through the pure runtime
 * and is persisted before it's acknowledged. Actions are serialized so a
 * voice call and a pinch can't interleave.
 */
export function useAppletSession(
  definition: AppletDefinition,
  initial: AppletState,
  persist: (state: AppletState) => Promise<void> = async () => {},
): AppletSession {
  const [, setState] = useState(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const ref = useRef(initial);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  // A new definition or a reset replaces the session state.
  useEffect(() => {
    ref.current = initial;
    setState(initial);
  }, [definition, initial]);

  const commit = useCallback(
    async (next: AppletState) => {
      if (next === ref.current) return;
      await persist(next);
      ref.current = next;
      setState(next);
    },
    [persist],
  );

  const serial = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.current.then(fn, fn);
    queue.current = p.catch(() => {});
    return p;
  }, []);

  const run = useCallback(
    (actionId: string, args: Record<string, unknown> = {}) =>
      serial(async () => {
        const r = dispatch(definition, ref.current, actionId, args);
        if (r.ok) {
          await commit(r.state);
          setNotice(null);
        } else setNotice(r.message);
        return r;
      }),
    [definition, commit, serial],
  );

  const step = useCallback((viewId: string, by: 1 | -1) => serial(() => commit(stepSequence(definition, ref.current, viewId, by))), [definition, commit, serial]);
  const update = useCallback(
    (fn: (s: AppletState) => AppletState) => serial(async () => { await commit(fn(ref.current)); return ref.current; }),
    [commit, serial],
  );
  const setView = useCallback((viewId: string) => void serial(() => commit(withView(ref.current, viewId))), [commit, serial]);

  // Tool callers can read again before React renders the committed update.
  // Always expose the latest persisted state, including through older handles.
  return { definition, get state() { return ref.current; }, run, step, update, setView, notice, clearNotice: () => setNotice(null) };
}
