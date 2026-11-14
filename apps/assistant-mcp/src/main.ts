import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthoringApi } from './api.ts';
import { createAssistantServer } from './server.ts';
import { createLocalHttpServer } from './http.ts';

const api = new AuthoringApi(process.env.JUNCTION26_API_ORIGIN ?? 'http://127.0.0.1:8080', process.env.JUNCTION26_AUTHORING_TOKEN ?? '');
const mode = process.argv[2] ?? 'stdio';
if (mode === 'stdio') {
  const server = createAssistantServer(api);
  await server.connect(new StdioServerTransport());
} else if (mode === 'http-local') {
  const port = Number(process.env.JUNCTION26_MCP_PORT ?? '8090');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid JUNCTION26_MCP_PORT');
  const http = createLocalHttpServer(api);
  http.listen(port, '127.0.0.1', () => console.error(`Junction26 private MCP: http://127.0.0.1:${port}/mcp`));
  const stop = () => { http.close(); http.closeIdleConnections(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} else throw new Error('Use stdio or http-local');
