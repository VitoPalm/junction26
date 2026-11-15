import { Hono } from 'hono';
import { z } from 'zod';
import { enqueueJob, getUpload } from '@junction26/db';
import type { AppEnv, Deps } from '../context.ts';
import { assertBudget } from '../budget.ts';
import { authorId } from '../auth.ts';
import { ApiError, notFound } from '../errors.ts';
import { jobView, readJson, uuid } from '../http.ts';

/**
 * Laundry label reading (docs/laundry.md). The phone uploads a label photo
 * through /v1/uploads, then asks for it to be read here; the result arrives
 * on GET /v1/jobs/:id. One job per photo (idempotent), owner-scoped.
 */
const Body = z.object({ uploadId: uuid, region: z.enum(['iso', 'us']).default('us') });

export function laundryRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.post('/labels', async (c) => {
    const userId = authorId(c);
    const body = await readJson(c, Body);
    const upload = await getUpload(deps.pool, userId, body.uploadId);
    if (!upload) throw notFound('Upload');
    if (!upload.mediaType.startsWith('image/')) throw new ApiError(422, 'not_an_image', 'Upload a photo of the care label');
    if (upload.status !== 'ready' && upload.status !== 'stored') throw new ApiError(409, 'upload_not_ready', `The photo is ${upload.status}`);
    await assertBudget(deps, userId, deps.config.laundry.labelModel);
    const { job, created } = await enqueueJob(deps.pool, {
      ownerId: userId,
      projectId: upload.projectId,
      kind: 'extract_care_label',
      input: { uploadId: upload.id, region: body.region },
      idempotencyKey: `label:${upload.id}:${body.region}`,
      maxAttempts: 2,
    });
    return c.json({ job: jobView(job), replayed: !created }, created ? 202 : 200);
  });
  return app;
}
