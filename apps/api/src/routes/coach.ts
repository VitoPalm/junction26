import { Hono } from 'hono';
import { z } from 'zod';
import { enqueueJob, getJobForOwner, getProject, getReleaseById, getRevision, requestJobCancel, type Job } from '@junction26/db';
import { validateDefinition } from '@junction26/applet-format';
import { stepIndex } from '@junction26/applet-runtime';
import type { AppEnv, Deps } from '../context.ts';
import { assertBudget } from '../budget.ts';
import { requireDevice } from '../auth.ts';
import { ApiError, notFound } from '../errors.ts';
import { param, readJson, uuid } from '../http.ts';

/**
 * Task coach requests from the glasses (docs/task-coach.md). Device sessions
 * only, owner-scoped. The request is pinned to the project's published
 * revision and runs as a `coach_request` job; the glasses poll for the
 * result, so no WebMCP callback or HTTP request waits on a model.
 */

const RequestBody = z.object({
  /** Chosen by the glasses; resending it returns the same job. */
  operationId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
  projectId: uuid,
  kind: z.enum(['question', 'problem']),
  stepId: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  text: z.string().trim().min(1).max(500),
  clarifications: z.array(z.string().trim().min(1).max(200)).max(3).default([]),
});

/** Only what the glasses need: no usage, attempts or internal error details. */
function coachView(job: Job) {
  const error = job.error as { code?: string } | null;
  return {
    id: job.id,
    status: job.status,
    result: job.status === 'succeeded' ? job.result : null,
    error: job.status === 'failed' ? { code: error?.code ?? 'failed', retryable: (error?.code ?? '').startsWith('model_') } : null,
  };
}

export function coachRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.post('/requests', async (c) => {
    const principal = c.get('principal');
    requireDevice(principal);
    const body = await readJson(c, RequestBody);
    const project = await getProject(deps.pool, principal.userId, body.projectId);
    if (!project) throw notFound('Project');
    if (!project.currentReleaseId) throw new ApiError(409, 'not_published', 'Publish this solution before asking about it');
    const release = await getReleaseById(deps.pool, project.currentReleaseId);
    const revision = release && release.projectId === project.id ? await getRevision(deps.pool, project.id, release.revisionId) : null;
    const parsed = revision ? validateDefinition(revision.definition) : null;
    if (!revision || !parsed?.ok || !parsed.definition.guide) throw new ApiError(409, 'not_a_guide', 'This solution has no manual to answer from');
    if (stepIndex(parsed.definition, body.stepId) < 0) throw new ApiError(422, 'unknown_step', 'That step is not in the published guide');

    await assertBudget(deps, principal.userId, deps.config.coach.model);
    const { job, created } = await enqueueJob(deps.pool, {
      ownerId: principal.userId,
      projectId: project.id,
      kind: 'coach_request',
      input: { projectId: project.id, revisionId: revision.id, stepId: body.stepId, kind: body.kind, text: body.text, clarifications: body.clarifications },
      idempotencyKey: `coach:${principal.deviceId}:${body.operationId}`,
      maxAttempts: 2,
    });
    c.get('log').info('coach request', { projectId: project.id, jobId: job.id, kind: body.kind, created });
    return c.json({ request: coachView(job), replayed: !created }, created ? 202 : 200);
  });

  app.get('/requests/:jobId', async (c) => {
    const principal = c.get('principal');
    requireDevice(principal);
    const job = await getJobForOwner(deps.pool, principal.userId, param(c, 'jobId'));
    if (!job || job.kind !== 'coach_request') throw notFound('Request');
    return c.json({ request: coachView(job) });
  });

  app.post('/requests/:jobId/cancel', async (c) => {
    const principal = c.get('principal');
    requireDevice(principal);
    const existing = await getJobForOwner(deps.pool, principal.userId, param(c, 'jobId'));
    if (!existing || existing.kind !== 'coach_request') throw notFound('Request');
    const job = await requestJobCancel(deps.pool, principal.userId, existing.id);
    return c.json({ request: coachView(job ?? existing) }, 202);
  });

  return app;
}
