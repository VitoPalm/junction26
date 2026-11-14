import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  createRelease,
  enqueueJob,
  findJobByIdempotencyKey,
  getProject,
  getReleaseById,
  getReleaseForOwner,
  getRevision,
  listReleases,
  revisionNeedsReview,
  withTransaction,
  type Job,
} from '@junction26/db';
import type { AppEnv, Deps } from '../context.ts';
import { authorId } from '../auth.ts';
import { ApiError, conflict, notFound } from '../errors.ts';
import { etagMatches, idempotencyKey, jobView, param, readJson, releaseView, requestFingerprint, uuid } from '../http.ts';

const PublishBody = z.object({
  revisionId: uuid,
  /** The release the client believes is current; null for a first publish. */
  expectedCurrentReleaseId: uuid.nullable(),
});

/** Routes under /v1/projects/:projectId/releases. */
export function projectReleaseRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.get('/:projectId/releases', async (c) => {
    const userId = authorId(c);
    const projectId = param(c, 'projectId');
    if (!(await getProject(deps.pool, userId, projectId))) throw notFound('Project');
    return c.json({ releases: (await listReleases(deps.pool, projectId)).map(releaseView) });
  });

  /**
   * Publish: queue packaging of an explicit revision with a precondition on
   * the current release. The project pointer moves only when the package is
   * durable and the precondition still holds (worker, `package_release`).
   */
  app.post('/:projectId/releases', async (c) => {
    const userId = authorId(c);
    const projectId = param(c, 'projectId');
    const key = idempotencyKey(c, true)!;
    const body = await readJson(c, PublishBody);
    const fingerprint = requestFingerprint({ projectId, ...body });

    const existing = await findJobByIdempotencyKey(deps.pool, userId, key);
    if (existing) return c.json(await publishReplay(existing, fingerprint), 200);

    const result = await withTransaction(deps.pool, async (tx) => {
      const project = await getProject(tx, userId, projectId, { forUpdate: true });
      if (!project) throw notFound('Project');
      if (project.currentReleaseId !== body.expectedCurrentReleaseId) {
        throw conflict('release_precondition_failed', 'The current release changed; reload and publish again', {
          currentReleaseId: project.currentReleaseId,
        });
      }
      const revision = await getRevision(tx, projectId, body.revisionId);
      if (!revision) throw notFound('Revision');
      if (revision.validationStatus !== 'valid') {
        throw new ApiError(422, 'revision_invalid', 'Only a valid revision can be published', { issues: revision.validationIssues });
      }
      if (await revisionNeedsReview(tx, revision.id)) {
        throw conflict('review_required', 'This revision removes or changes existing data; accept the change review first');
      }
      const release = await createRelease(tx, {
        projectId,
        revisionId: revision.id,
        baseReleaseId: body.expectedCurrentReleaseId,
        minimumRuntimeVersion: revision.minimumRuntimeVersion,
      });
      const { job, created } = await enqueueJob(tx, {
        ownerId: userId,
        projectId,
        kind: 'package_release',
        input: { releaseId: release.id, fingerprint },
        idempotencyKey: key,
        maxAttempts: 5,
      });
      if (!created) throw new RaceReplay(job);
      return { release, job };
    }).catch((err: unknown) => {
      if (err instanceof RaceReplay) return { replay: err.job };
      throw err;
    });

    if ('replay' in result) return c.json(await publishReplay(result.replay, fingerprint), 200);
    c.get('log').info('publish queued', { projectId, releaseId: result.release.id, jobId: result.job.id });
    return c.json({ release: releaseView(result.release), job: jobView(result.job) }, 202);
  });

  async function publishReplay(job: Job, fingerprint: string) {
    if (job.kind !== 'package_release' || job.input.fingerprint !== fingerprint) {
      throw conflict('idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
    }
    const release = await getReleaseById(deps.pool, job.input.releaseId as string);
    return { release: release ? releaseView(release) : null, job: jobView(job) };
  }

  /**
   * Explicit-sync manifest for the glasses. Small, conditional (ETag = release
   * ID), never polled continuously.
   */
  app.get('/:projectId/releases/latest', async (c) => {
    const userId = c.get('principal').userId;
    const project = await getProject(deps.pool, userId, param(c, 'projectId'));
    if (!project) throw notFound('Project');
    if (!project.currentReleaseId) throw new ApiError(404, 'no_release', 'This project has not been published yet');
    const etag = `"${project.currentReleaseId}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    if (etagMatches(c, etag)) return c.body(null, 304);
    const release = await getReleaseById(deps.pool, project.currentReleaseId);
    return c.json({ projectId: project.id, title: project.title, release: releaseView(release!) });
  });

  return app;
}

/** Concurrent request with the same key committed first; roll back and replay. */
class RaceReplay extends Error {
  readonly job: Job;
  constructor(job: Job) {
    super('idempotent replay');
    this.job = job;
  }
}

/** Routes under /v1/releases. */
export function releaseRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  /**
   * Streams an immutable package from object storage. Browsers never talk to
   * Verda (no CORS), so this is the only download path.
   */
  app.get('/:releaseId/package', async (c) => {
    const release = await getReleaseForOwner(deps.pool, c.get('principal').userId, param(c, 'releaseId'));
    if (!release || release.status !== 'ready') throw notFound('Release package');
    const etag = `"${release.packageSha256}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    if (etagMatches(c, etag)) return c.body(null, 304);
    const object = await deps.store.get(release.packageKey!);
    if (!object) {
      c.get('log').error('release package missing from storage', { releaseId: release.id });
      throw new ApiError(500, 'package_missing', 'The release package is unavailable');
    }
    c.header('Content-Type', 'application/json');
    c.header('Content-Length', String(object.contentLength));
    c.header('X-Content-SHA256', release.packageSha256!);
    return c.body(Readable.toWeb(object.body) as ReadableStream);
  });

  return app;
}
