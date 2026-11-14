import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createAssistantServer } from '@junction26/assistant-mcp';
import { AuthoringApiError, type AuthoringBackend } from '@junction26/assistant-mcp/api';
import type { AppEnv, Deps } from './context.ts';
import { ApiError, errorBody } from './errors.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { authoringRoutes } from './routes/authoring.ts';
import { projectRoutes } from './routes/projects.ts';
import { clerkMcpVerifier, MCP_SCOPES, type AssistantPrincipal } from './mcp-auth.ts';

/** Token-free, request-scoped dispatch into the existing application routes.
 * Only this explicit subset can be reached, regardless of advertised tools.
 */
export function scopedAuthoringBackend(deps: Deps, principal: AssistantPrincipal): AuthoringBackend {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('principal', principal); c.set('log', deps.logger); await next(); });
  app.onError((err, c) => err instanceof ApiError
    ? c.json(errorBody(err.code, err.message, err.details), err.status)
    : c.json(errorBody('internal', 'The authoring operation failed'), 500));
  app.route('/assistant', assistantRoutes(deps));
  app.route('/projects', projectRoutes(deps));
  app.route('/projects', authoringRoutes(deps));
  return {
    async request(path, options = {}) {
      let required: typeof MCP_SCOPES[number] | null = null;
      const post = options.body !== undefined;
      if (!post && (path === 'projects' || path === 'assistant/capabilities' || /^projects\/[a-f0-9-]+\/revisions(?:\/[a-f0-9-]+)?$/.test(path))) required = 'applets:read';
      if (post && path === 'assistant/validate') required = 'applets:read';
      if (post && path === 'assistant/drafts') required = 'applets:draft';
      if (!required) throw new AuthoringApiError(403, errorBody('forbidden', 'This operation is not available to assistants'));
      if (!principal.scopes.includes(required)) throw new AuthoringApiError(403, errorBody('insufficient_scope', `This operation requires ${required}`, { requiredScope: required }));
      const headers: Record<string, string> = {};
      if (post) headers['content-type'] = 'application/json';
      if (options.operationId) headers['idempotency-key'] = options.operationId;
      const response = await app.request(`http://internal/${path}`, {
        method: post ? 'POST' : 'GET', headers,
        ...(post ? { body: JSON.stringify(options.body) } : {}),
        signal: options.signal,
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new AuthoringApiError(response.status, body);
      return body;
    },
  };
}

/** Mounted only with explicit Clerk + canonical resource configuration. */
export function mcpRoutes(deps: Deps, verify = clerkMcpVerifier(deps)) {
  const app = new Hono<AppEnv>();
  const mcp = deps.config.mcp!;
  const resource = new URL(mcp.resourceUrl);
  const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', resource).href;
  const challenge = `Bearer resource_metadata="${metadataUrl}"`;
  const metadata = { resource: mcp.resourceUrl, authorization_servers: [deps.config.clerk!.issuer], scopes_supported: [...MCP_SCOPES], bearer_methods_supported: ['header'], resource_name: 'Junction26 applet authoring' };
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(metadata));
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(metadata));
  app.use('/mcp', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Access-Control-Expose-Headers', 'WWW-Authenticate');
    // Compare against configuration, not forwarded headers supplied by a client.
    if (c.req.header('host') && c.req.header('host') !== resource.host) return c.json({ error: 'invalid_host' }, 403);
    const origin = c.req.header('origin');
    if (origin && origin !== resource.origin && !deps.config.corsOrigins.includes(origin)) return c.json({ error: 'invalid_origin' }, 403);
    if (origin) { c.header('Access-Control-Allow-Origin', origin); c.header('Vary', 'Origin'); }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version');
      return c.body(null, 204);
    }
    return next();
  });
  app.use('/mcp', bodyLimit({ maxSize: deps.config.limits.maxDefinitionBytes + 64 * 1024 }));
  app.post('/mcp', async (c) => {
    const principal = await verify(c.req.raw);
    if (!principal || principal.resource !== mcp.resourceUrl) {
      c.header('WWW-Authenticate', challenge);
      return c.json({ error: 'invalid_token' }, 401);
    }
    if (!principal.scopes.includes('applets:read')) {
      c.header('WWW-Authenticate', `${challenge}, error="insufficient_scope", scope="applets:read"`);
      return c.json({ error: 'insufficient_scope' }, 403);
    }
    const server = createAssistantServer(scopedAuthoringBackend(deps, principal), { resourceMetadataUrl: metadataUrl });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      // Short JSON responses only: finish consuming before closing the per-request transport.
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    } finally { await server.close(); }
  });
  app.all('/mcp', (c) => { c.header('Allow', 'POST, OPTIONS'); return c.json({ error: 'method_not_allowed' }, 405); });
  return app;
}
