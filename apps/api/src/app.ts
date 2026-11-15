import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { cors } from 'hono/cors';
import type { AppEnv, Deps } from './context.ts';
import { mcpRoutes } from './mcp.ts';
import { authenticate } from './auth.ts';
import { ApiError, errorBody } from './errors.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { projectRoutes } from './routes/projects.ts';
import { authoringRoutes } from './routes/authoring.ts';
import { projectReleaseRoutes, releaseRoutes } from './routes/releases.ts';
import { stateRoutes } from './routes/state.ts';
import { coachRoutes } from './routes/coach.ts';
import { laundryRoutes } from './routes/laundry.ts';
import { uploadRoutes } from './routes/uploads.ts';
import { deviceRoutes, healthRoutes, jobRoutes, pairRoute } from './routes/misc.ts';
import { authoringMetaRoutes, webRoutes } from './routes/web.ts';
import { voiceRoutes } from './routes/voice.ts';
import { fakeVoice, VoiceHub } from './voice.ts';
import { noteRoutes } from './routes/notes.ts';
import { fakeLive, isLiveRequest, NoteHub } from './notes.ts';
import { registryFromSettings } from '@junction26/model';


/**
 * Builds the HTTP application. Pure: no listening socket, so tests call
 * `app.request()` directly. The contract is documented in docs/api.md.
 */
export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const voiceHub = deps.voice ?? new VoiceHub();
  const noteHub = deps.notes ?? new NoteHub();
  const models =
    deps.models ??
    registryFromSettings(deps.config.model, (req) => isLiveRequest(req) ? fakeLive(req) : fakeVoice(req));

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
  if (deps.config.mcp) app.route('/', mcpRoutes(deps));

  // Native app shells (Capacitor) and dev servers run on other origins. Bearer
  // tokens, not cookies, so credentials mode stays off.
  if (deps.config.corsOrigins.length) {
    app.use(
      '/v1/*',
      cors({
        origin: deps.config.corsOrigins,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['authorization', 'content-type', 'idempotency-key', 'if-none-match', 'x-request-id', 'x-utterance-id'],
        exposeHeaders: ['x-request-id', 'etag', 'x-content-sha256'],
        maxAge: 600,
      }),
    );
  }

  // JSON bodies are small; uploads have their own streaming limit.
  const jsonLimit = bodyLimit({
    maxSize: Math.max(deps.config.limits.maxDefinitionBytes, deps.config.limits.maxStateBytes) + 64 * 1024,
    onError: (c) => c.json(errorBody('payload_too_large', 'The request body is too large'), 413),
  });
  // Uploads, voice clips and voice-note audio enforce their own limits.
  const ownLimit = (path: string) =>
    path.startsWith('/v1/uploads') || path === '/v1/voice/utterances' || /^\/v1\/notes\/[^/]+\/(audio|live)$/.test(path);
  app.use('/v1/*', async (c, next) => (ownLimit(c.req.path) ? next() : jsonLimit(c, next)));

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
  v1.route('/coach', coachRoutes(deps));
  v1.route('/laundry', laundryRoutes(deps));
  v1.route('/authoring', authoringMetaRoutes(deps, models));
  v1.route('/assistant', assistantRoutes(deps));
  v1.route('/voice', voiceRoutes(deps, voiceHub, models, noteHub));
  v1.route('/notes', noteRoutes(deps, noteHub, models));
  app.route('/v1', v1);

  if (deps.config.webRoot) app.route('/', webRoutes(deps.config.webRoot));

  return app;
}
