import { Hono } from 'hono';
import { z } from 'zod';
import {
  createMessage,
  createRevision,
  enqueueJob,
  findJobByIdempotencyKey,
  getProject,
  getRevision,
  getUploadsByIds,
  listMessages,
  listRevisions,
  withTransaction,
  type Job,
} from '@junction26/db';
import { checkDefinition } from '@junction26/server-common';
import type { AppEnv, Deps } from '../context.ts';
import { authorId } from '../auth.ts';
import { ApiError, badRequest, conflict, notFound } from '../errors.ts';
import { idempotencyKey, jobView, messageView, param, readJson, requestFingerprint, revisionSummaryView, revisionView, uuid } from '../http.ts';

const MessageBody = z.object({
  text: z.string().trim().min(1).max(8000),
  attachmentIds: z.array(uuid).max(20).default([]),
  baseRevisionId: uuid.nullable().default(null),
  /** A model spec from GET /v1/authoring/models; default when omitted. */
  model: z.string().max(200).optional(),
});

const RevisionBody = z.object({
  definition: z.unknown(),
  baseRevisionId: uuid.nullable().default(null),
});

/** Authoring: chat messages (which queue generation) and candidate revisions. */
export function authoringRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.get('/:projectId/messages', async (c) => {
    const userId = authorId(c);
    const projectId = param(c, 'projectId');
    if (!(await getProject(deps.pool, userId, projectId))) throw notFound('Project');
    return c.json({ messages: (await listMessages(deps.pool, userId, projectId)).map(messageView) });
  });

  /**
   * Saves the user's message and queues a generation job against an explicit
   * base revision. Returns 202 immediately; poll GET /v1/jobs/:id.
   */
  app.post('/:projectId/messages', async (c) => {
    const userId = authorId(c);
    const projectId = param(c, 'projectId');
    const key = idempotencyKey(c, false);
    const body = await readJson(c, MessageBody);
    if (body.model !== undefined && !deps.config.model.allowed.includes(body.model)) {
      throw badRequest('That model is not available', { allowed: deps.config.model.allowed });
    }
    const fingerprint = requestFingerprint({ projectId, ...body });

    const replay = key ? await findJobByIdempotencyKey(deps.pool, userId, key) : null;
    if (replay) return c.json(await messageReplay(replay, fingerprint, userId, projectId), 200);

    const result = await withTransaction(deps.pool, async (tx) => {
      const project = await getProject(tx, userId, projectId, { forUpdate: true });
      if (!project) throw notFound('Project');
      if (body.baseRevisionId && !(await getRevision(tx, projectId, body.baseRevisionId))) {
        throw badRequest('baseRevisionId is not a revision of this project');
      }
      const uploads = await getUploadsByIds(tx, userId, body.attachmentIds);
      const missing = body.attachmentIds.filter((id) => !uploads.some((u) => u.id === id));
      if (missing.length) throw badRequest('Unknown attachment IDs', { missing });
      const unusable = uploads.filter((u) => u.status === 'rejected' || u.status === 'failed').map((u) => u.id);
      if (unusable.length) throw badRequest('Some attachments failed processing', { unusable });

      const { job, created } = await enqueueJob(tx, {
        ownerId: userId,
        projectId,
        kind: 'generate_revision',
        input: {
          projectId,
          baseRevisionId: body.baseRevisionId,
          attachmentIds: body.attachmentIds,
          model: body.model ?? deps.config.model.model,
          fingerprint,
        },
        idempotencyKey: key,
        maxAttempts: 2,
      });
      if (!created) return { kind: 'replay' as const, job };
      const message = await createMessage(tx, {
        projectId,
        ownerId: userId,
        role: 'user',
        body: body.text,
        attachmentIds: body.attachmentIds,
        jobId: job.id,
      });
      await tx.query(`UPDATE jobs SET input = input || jsonb_build_object('messageId', $2::text) WHERE id = $1`, [job.id, message.id]);
      return { kind: 'created' as const, message, job };
    });

    if (result.kind === 'replay') return c.json(await messageReplay(result.job, fingerprint, userId, projectId), 200);
    c.get('log').info('generation queued', { projectId, jobId: result.job.id });
    return c.json({ message: messageView(result.message), job: jobView(result.job) }, 202);
  });

  async function messageReplay(job: Job, fingerprint: string, userId: string, projectId: string) {
    if (job.kind !== 'generate_revision' || job.input.fingerprint !== fingerprint) {
      throw conflict('idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
    }
    const messages = await listMessages(deps.pool, userId, projectId);
    const message = messages.find((m) => m.jobId === job.id);
    return { message: message ? messageView(message) : null, job: jobView(job) };
  }

  app.get('/:projectId/revisions', async (c) => {
    const userId = authorId(c);
    const projectId = param(c, 'projectId');
    if (!(await getProject(deps.pool, userId, projectId))) throw notFound('Project');
    return c.json({ revisions: (await listRevisions(deps.pool, projectId)).map(revisionSummaryView) });
  });

  /**
   * Submits a complete candidate definition directly (bring-your-own
   * assistant, scripted authoring, tests). Invalid definitions are rejected
   * with every issue and not stored.
   */
  app.post('/:projectId/revisions', async (c) => {
    const userId = authorId(c);
    const projectId = param(c, 'projectId');
    const body = await readJson(c, RevisionBody);
    const check = checkDefinition(body.definition, deps.config.limits.maxDefinitionBytes);
    if (!check.ok) throw new ApiError(422, 'invalid_definition', 'The applet definition is invalid', { issues: check.issues });

    const revision = await withTransaction(deps.pool, async (tx) => {
      if (!(await getProject(tx, userId, projectId, { forUpdate: true }))) throw notFound('Project');
      if (body.baseRevisionId && !(await getRevision(tx, projectId, body.baseRevisionId))) {
        throw badRequest('baseRevisionId is not a revision of this project');
      }
      return createRevision(tx, {
        projectId,
        baseRevisionId: body.baseRevisionId,
        definition: body.definition,
        formatVersion: check.formatVersion,
        minimumRuntimeVersion: check.minimumRuntimeVersion,
        validationStatus: 'valid',
        validationIssues: [],
        source: 'client',
      });
    });
    c.get('log').info('revision created', { projectId, revisionId: revision.id, number: revision.number });
    return c.json({ revision: revisionSummaryView(revision) }, 201);
  });

  app.get('/:projectId/revisions/:revisionId', async (c) => {
    const userId = authorId(c);
    const projectId = param(c, 'projectId');
    if (!(await getProject(deps.pool, userId, projectId))) throw notFound('Project');
    const revision = await getRevision(deps.pool, projectId, param(c, 'revisionId'));
    if (!revision) throw notFound('Revision');
    return c.json({ revision: revisionView(revision) });
  });

  return app;
}
