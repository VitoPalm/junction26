import { Hono } from 'hono';
import { z } from 'zod';
import {
  consumePairingCode,
  createDevice,
  createPairingCode,
  getJobForOwner,
  listDevices,
  requestJobCancel,
  revokeDevice,
  withTransaction,
} from '@junction26/db';
import type { AppEnv, Deps } from '../context.ts';
import { authorId, hmac, newDeviceToken, newPairingCode, normalizePairingCode, PAIRING_CODE_TTL_MS } from '../auth.ts';
import { ApiError, notFound } from '../errors.ts';
import { deviceView, jobView, param, readJson } from '../http.ts';

export function jobRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.get('/:jobId', async (c) => {
    const job = await getJobForOwner(deps.pool, authorId(c), param(c, 'jobId'));
    if (!job) throw notFound('Job');
    return c.json({ job: jobView(job) });
  });

  app.post('/:jobId/cancel', async (c) => {
    const job = await requestJobCancel(deps.pool, authorId(c), param(c, 'jobId'));
    if (!job) throw notFound('Job');
    return c.json({ job: jobView(job) }, 202);
  });

  return app;
}

/** Device management for signed-in users. Pairing itself is public (see pairRoute). */
export function deviceRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.post('/pairing-codes', async (c) => {
    const userId = authorId(c);
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    await createPairingCode(deps.pool, userId, hmac(deps.config.sessionSecret, 'pair', normalizePairingCode(code)), expiresAt);
    // The glasses app can open this link (e.g. from a QR code) to pair without typing.
    const pairUrl = `${deps.config.publicOrigin}/glasses/#pair=${encodeURIComponent(code)}`;
    return c.json({ code, expiresAt, pairUrl }, 201);
  });

  app.get('/', async (c) => c.json({ devices: (await listDevices(deps.pool, authorId(c))).map(deviceView) }));

  app.delete('/:deviceId', async (c) => {
    const device = await revokeDevice(deps.pool, authorId(c), param(c, 'deviceId'));
    if (!device) throw notFound('Device');
    c.get('log').info('device revoked', { deviceId: device.id });
    return c.json({ device: deviceView(device) });
  });

  return app;
}

/**
 * `POST /v1/devices/pair`: exchanges a one-use pairing code for a device
 * session token. Unauthenticated by design; the code is the credential.
 */
export function pairRoute(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.post('/', async (c) => {
    const body = await readJson(c, z.object({ code: z.string().min(4).max(32), label: z.string().trim().min(1).max(64).default('Glasses') }));
    const codeHash = hmac(deps.config.sessionSecret, 'pair', normalizePairingCode(body.code));
    const token = newDeviceToken();
    const device = await withTransaction(deps.pool, async (tx) => {
      const ownerId = await consumePairingCode(tx, codeHash);
      if (!ownerId) return null;
      return createDevice(tx, ownerId, body.label, hmac(deps.config.sessionSecret, 'device', token));
    });
    if (!device) throw new ApiError(400, 'invalid_pairing_code', 'The code is wrong, expired or already used');
    c.get('log').info('device paired', { deviceId: device.id, userId: device.ownerId });
    // The token is shown exactly once. Store it on the device; it can't be recovered.
    return c.json({ token, device: deviceView(device) }, 201);
  });
  return app;
}

export function healthRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    const checks: Record<string, 'ok' | 'error'> = {};
    const timeout = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000).unref())]);
    await Promise.all([
      timeout(deps.pool.query('SELECT 1')).then(
        () => (checks.database = 'ok'),
        (err: unknown) => {
          checks.database = 'error';
          c.get('log').warn('readiness: database failed', { err });
        },
      ),
      timeout(deps.store.ping()).then(
        () => (checks.storage = 'ok'),
        (err: unknown) => {
          checks.storage = 'error';
          c.get('log').warn('readiness: storage failed', { err });
        },
      ),
    ]);
    const ok = Object.values(checks).every((v) => v === 'ok');
    return c.json({ ok, checks }, ok ? 200 : 503);
  });
  return app;
}
