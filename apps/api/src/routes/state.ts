import { Hono } from 'hono';
import { z } from 'zod';
import { getCurrentState, getProject, putStateBackup } from '@junction26/db';
import type { AppEnv, Deps } from '../context.ts';
import { requireDevice } from '../auth.ts';
import { ApiError, conflict, notFound } from '../errors.ts';
import { param, readJson, uuid } from '../http.ts';

const StateBody = z.object({
  operationId: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  revisionId: uuid.nullable(),
  schemaVersion: z.number().int().nonnegative(),
  expectedServerVersion: z.number().int().nonnegative(),
  snapshot: z.record(z.string(), z.unknown()),
});

/** Routes under /v1/projects/:projectId/state. */
export function stateRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  /**
   * Versioned, idempotent backup from the glasses (the single writer). Only
   * device sessions may write: authoring edits definitions, never live values.
   */
  app.put('/:projectId/state', async (c) => {
    const principal = c.get('principal');
    requireDevice(principal);
    const projectId = param(c, 'projectId');
    // The header is optional (for example with chunked requests). The global
    // body limit bounds buffering; enforce the smaller state limit on actual bytes.
    const length = Buffer.byteLength(await c.req.text());
    if (length > deps.config.limits.maxStateBytes) {
      throw new ApiError(413, 'payload_too_large', `State snapshots are limited to ${deps.config.limits.maxStateBytes} bytes`);
    }
    const body = await readJson(c, StateBody);
    if (!(await getProject(deps.pool, principal.userId, projectId))) throw notFound('Project');

    const result = await putStateBackup(deps.pool, { projectId, deviceId: principal.deviceId, ...body });
    const log = c.get('log').child({ projectId, operationId: body.operationId });
    if (result.outcome === 'accepted') {
      log.info('state backup accepted', { serverVersion: result.serverVersion, replayed: result.replayed });
      return c.json({ outcome: 'accepted', serverVersion: result.serverVersion, replayed: result.replayed });
    }
    log.warn('state backup refused', { outcome: result.outcome });
    throw conflict(
      result.outcome === 'conflict' ? 'state_conflict' : 'state_stale',
      result.outcome === 'conflict'
        ? 'The server has a newer backup than this device last saw. Both snapshots were kept.'
        : 'This device already backed up a later sequence.',
      { current: result.current, replayed: result.replayed },
    );
  });

  /** The last accepted backup, for recovery on a new or reset device. */
  app.get('/:projectId/state', async (c) => {
    const userId = c.get('principal').userId;
    const projectId = param(c, 'projectId');
    if (!(await getProject(deps.pool, userId, projectId))) throw notFound('Project');
    const current = await getCurrentState(deps.pool, projectId);
    if (!current) throw new ApiError(404, 'no_state', 'No state backup exists for this project');
    return c.json({
      serverVersion: current.serverVersion,
      deviceId: current.deviceId,
      sequence: current.sequence,
      revisionId: current.backup.revisionId,
      schemaVersion: current.backup.schemaVersion,
      snapshot: current.backup.snapshot,
      savedAt: current.backup.createdAt,
    });
  });

  return app;
}
