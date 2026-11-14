import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Deps } from './context.ts';
import { authenticate } from './auth.ts';
import { ApiError, errorBody } from './errors.ts';
import { projectRoutes } from './routes/projects.ts';
import { authoringRoutes } from './routes/authoring.ts';
import { projectReleaseRoutes, releaseRoutes } from './routes/releases.ts';
import { stateRoutes } from './routes/state.ts';
import { uploadRoutes } from './routes/uploads.ts';
import { deviceRoutes, healthRoutes, jobRoutes, pairRoute } from './routes/misc.ts';

/**
 * Builds the HTTP application. Pure: no listening socket, so tests call
 * `app.request()` directly. The contract is documented in docs/api.md.
 */
export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    const log = deps.logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('log', log);
    c.header('X-Request-Id', requestId);
    const started = performance.now();
    await next();
    // Route pattern, not the raw URL: query strings can carry filenames.
    log.info('request', {
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message, err.details), err.status);
    if (err instanceof HTTPException) {
      const status = err.status;
      return c.json(errorBody(status === 413 ? 'payload_too_large' : 'http_error', err.message || 'Request failed'), status);
    }
    (c.get('log') ?? deps.logger).error('unhandled error', { err });
    return c.json(errorBody('internal', 'Something went wrong'), 500);
  });

  app.notFound((c) => c.json(errorBody('not_found', 'No such endpoint'), 404));

  app.route('/', healthRoutes(deps));

  // JSON bodies are small; uploads have their own streaming limit.
  const jsonLimit = bodyLimit({
    maxSize: Math.max(deps.config.limits.maxDefinitionBytes, deps.config.limits.maxStateBytes) + 64 * 1024,
    onError: (c) => c.json(errorBody('payload_too_large', 'The request body is too large'), 413),
  });
  app.use('/v1/*', async (c, next) => (c.req.path.startsWith('/v1/uploads') ? next() : jsonLimit(c, next)));

  app.route('/v1/devices/pair', pairRoute(deps));

  const v1 = new Hono<AppEnv>();
  v1.use('*', authenticate(deps));
  v1.get('/me', (c) => c.json({ principal: c.get('principal') }));
  v1.route('/projects', projectRoutes(deps));
  v1.route('/projects', authoringRoutes(deps));
  v1.route('/projects', projectReleaseRoutes(deps));
  v1.route('/projects', stateRoutes(deps));
  v1.route('/releases', releaseRoutes(deps));
  v1.route('/uploads', uploadRoutes(deps));
  v1.route('/jobs', jobRoutes(deps));
  v1.route('/devices', deviceRoutes(deps));
  app.route('/v1', v1);

  return app;
}
