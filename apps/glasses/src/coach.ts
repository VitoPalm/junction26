import { useEffect, useRef } from 'react';
import type { AppletSession } from '@junction26/applet-renderer';
import {
  applyResult, cancelRequest, coachOf, failRequest, setRequestError, setRequestJob,
  type CheckedRecovery, type CoachAnswer, type CoachRequest,
} from '@junction26/applet-runtime';
import type { InstalledApplet } from './store.ts';
import { call, HttpError, pairing } from './sync.ts';

/**
 * Task coach network runner (docs/task-coach.md). The only coach network use:
 * a question or problem report the wearer explicitly started. Pending
 * requests live in the saved applet state, so they survive closing the app
 * and losing connectivity; this hook sends them (same operation ID, so a
 * resend is idempotent), polls their job, applies the result once, and
 * retries when the connection comes back. Navigation and completion never
 * wait on it.
 */

interface CoachRequestView {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result: unknown;
  error: { code: string; retryable: boolean } | null;
}

const POLL_MS = [1000, 1500, 2500, 4000];

/** Shape checks on what the server returned (it was validated there too). */
function parseResult(kind: CoachRequest['kind'], raw: unknown):
  | { kind: 'question'; answer: Omit<CoachAnswer, 'requestId' | 'local'> }
  | { kind: 'problem'; recovery: CheckedRecovery }
  | null {
  const r = raw as { kind?: string; answer?: Record<string, unknown>; recovery?: Record<string, unknown> } | null;
  if (!r || r.kind !== kind) return null;
  if (kind === 'question' && r.answer && typeof r.answer.text === 'string' && ['answered', 'insufficient', 'clarify'].includes(String(r.answer.status)))
    return { kind, answer: { status: r.answer.status as CoachAnswer['status'], text: r.answer.text, sources: Array.isArray(r.answer.sources) ? r.answer.sources : [], options: Array.isArray(r.answer.options) ? r.answer.options.map(String) : [] } };
  if (kind === 'problem' && r.recovery && ['proposal', 'clarify', 'unsupported'].includes(String(r.recovery.status)))
    return { kind, recovery: r.recovery as unknown as CheckedRecovery };
  return null;
}

const PLAIN: Record<string, string> = {
  not_paired: 'Pair your phone to ask about the manual.',
  not_published: 'Publish this guide from your phone first.',
  not_a_guide: 'This guide has no manual to check.',
  not_found: 'This guide isn’t on your account.',
};

export function useCoachRunner(applet: InstalledApplet, session: () => AppletSession) {
  const inFlight = useRef(new Set<string>());
  const alive = useRef(true);
  const s = session();
  const pending = coachOf(s.state).requests.filter((r) => r.status === 'pending');
  const key = pending.map((r) => `${r.id}:${r.jobId ?? ''}:${r.error ?? ''}`).join(',');

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const update = (fn: Parameters<AppletSession['update']>[0]) => session().update(fn);
    const current = (id: string) => coachOf(session().state).requests.find((r) => r.id === id);

    async function drive(req: CoachRequest) {
      if (inFlight.current.has(req.id) || req.error) return; // An error waits for Retry or the connection.
      inFlight.current.add(req.id);
      try {
        const p = await pairing();
        if (!p || applet.demo) return void (await update((x) => failRequest(x, req.id, PLAIN.not_paired!)));
        let jobId = req.jobId;
        if (!jobId) {
          const { body } = await call<{ request: CoachRequestView }>('/v1/coach/requests', {
            method: 'POST', token: p.token,
            body: JSON.stringify({ operationId: req.id, projectId: applet.projectId, kind: req.kind, stepId: req.stepId, text: req.text, clarifications: req.clarifications }),
          });
          jobId = body.request.id;
          await update((x) => setRequestJob(x, req.id, jobId!));
        }
        for (let i = 0; alive.current; i++) {
          if (current(req.id)?.status !== 'pending') {
            // Cancelled on the glasses: tell the server too (best effort).
            await call(`/v1/coach/requests/${jobId}/cancel`, { method: 'POST', token: p.token }).catch(() => {});
            return;
          }
          const { body } = await call<{ request: CoachRequestView }>(`/v1/coach/requests/${jobId}`, { token: p.token });
          const v = body.request;
          if (v.status === 'succeeded') {
            const parsed = parseResult(req.kind, v.result);
            await update((x) => (parsed ? applyResult(session().definition, x, req.id, parsed) : failRequest(x, req.id, 'unexpected reply')));
            return;
          }
          if (v.status === 'cancelled') return void (await update((x) => cancelRequest(x, req.id)));
          if (v.status === 'failed') {
            const msg = PLAIN[v.error?.code ?? ''] ?? (v.error?.retryable ? 'the service is busy' : 'something went wrong');
            // Retryable failures stay pending with an error, so Retry resends a fresh request.
            return void (await update((x) => (v.error?.retryable ? setRequestError(setRequestJob(x, req.id, ''), req.id, msg) : failRequest(x, req.id, msg))));
          }
          await new Promise((r) => setTimeout(r, POLL_MS[Math.min(i, POLL_MS.length - 1)]));
        }
      } catch (e) {
        if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
          await update((x) => failRequest(x, req.id, PLAIN[e.code] ?? e.message));
        } else {
          await update((x) => setRequestError(x, req.id, 'offline'));
        }
      } finally {
        inFlight.current.delete(req.id);
      }
    }

    for (const r of pending) void drive(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, applet.projectId]);

  // Back online: clear "offline" so waiting requests resend (same operation ID).
  useEffect(() => {
    const online = () => {
      for (const r of coachOf(session().state).requests) if (r.status === 'pending' && r.error === 'offline') void session().update((x) => setRequestError(x, r.id, null));
    };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [session]);
}
