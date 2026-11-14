import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AuthoringApi } from './api.ts';
import { createAssistantServer } from './server.ts';

/** Loopback-only protocol development. Not a hosted, multi-user connector. */
export function createLocalHttpServer(api: AuthoringApi) {
  return createServer(async (req, res) => {
    // No browser origins or alternate Host names; block DNS rebinding and CSRF.
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '') || req.headers.origin) {
      res.writeHead(403).end(); return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const server = createAssistantServer(api);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'MCP request failed' }));
      else res.end();
      await server.close();
    }
  });
}
