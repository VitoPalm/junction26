import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AuthoringApi } from './api.ts';
import { createAssistantServer } from './server.ts';
import { createLocalHttpServer } from './http.ts';

const projectId = 'c7eca095-b79d-4bb7-a166-0dc876b705d5';
const revisionId = 'c7eca095-b79d-4bb7-a166-0dc876b705d6';

test('credentials and API origins fail closed', () => {
  assert.throws(() => new AuthoringApi('http://example.com', 'token'));
  assert.throws(() => new AuthoringApi('https://example.com', 'dev:me'));
  assert.throws(() => new AuthoringApi('http://127.0.0.1:8080', 'j26d_device'));
  assert.throws(() => new AuthoringApi('http://127.0.0.1:8080', ''));
  assert.throws(() => new AuthoringApi('https://user:pass@example.com', 'token'));
  assert.throws(() => new AuthoringApi('https://example.com/path', 'token'));
});

test('MCP discovery, read routing, writes, validation and recoverable errors', async (t) => {
  const requests: { url: string; body: any; key: string | undefined }[] = [];
  const api = new AuthoringApi('http://127.0.0.1:8080', 'dev:me', async (url, options) => {
    assert.equal(options?.redirect, 'error');
    const headers = options?.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer dev:me');
    requests.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : null, key: headers['idempotency-key'] });
    if (String(url).endsWith('/validate')) return Response.json({ valid: false, issues: [{ code: 'schema' }], measuredFit: 'not_checked' });
    if (headers['idempotency-key'] === 'conflict-key') return Response.json({ error: { code: 'stale_revision', message: 'Reload latest revision' } }, { status: 409 });
    return Response.json({ ok: true });
  });
  const server = createAssistantServer(api);
  const client = new Client({ name: 'protocol-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  assert.equal(tools.find((tool) => tool.name === 'create_applet')?.annotations?.readOnlyHint, false);
  assert.equal(tools.find((tool) => tool.name === 'validate_applet')?.annotations?.readOnlyHint, true);
  assert.ok(!tools.some((tool) => tool.name.includes('publish') || tool.name.includes('state')));
  await client.callTool({ name: 'get_authoring_capabilities', arguments: {} });
  await client.callTool({ name: 'list_applets', arguments: {} });
  await client.callTool({ name: 'get_applet', arguments: { projectId } });
  await client.callTool({ name: 'get_applet', arguments: { projectId, revisionId } });
  assert.deepEqual(requests.map((r) => new URL(r.url).pathname), ['/v1/assistant/capabilities', '/v1/projects', `/v1/projects/${projectId}/revisions`, `/v1/projects/${projectId}/revisions/${revisionId}`]);
  const invalid = await client.callTool({ name: 'validate_applet', arguments: { definition: {} } });
  assert.equal((invalid.structuredContent as Record<string, unknown>)?.measuredFit, 'not_checked');
  assert.equal((invalid.structuredContent as Record<string, unknown>)?.valid, false);
  const args = { title: 'Counter', definition: { formatVersion: 1 }, operationId: 'create-key' };
  await client.callTool({ name: 'create_applet', arguments: args });
  await client.callTool({ name: 'create_applet', arguments: args });
  assert.deepEqual(requests.at(-1), requests.at(-2));
  assert.equal(requests.at(-1)?.body.mode, 'create');
  const failed = await client.callTool({ name: 'revise_applet', arguments: { projectId, baseRevisionId: revisionId, definition: {}, operationId: 'conflict-key' } });
  assert.equal(failed.isError, true);
  assert.equal(((failed.structuredContent as Record<string, unknown>)?.error as { code: string }).code, 'stale_revision');
  const before = requests.length;
  const malformed = await client.callTool({ name: 'get_applet', arguments: { projectId: '../state' } });
  assert.equal(malformed.isError, true);
  assert.equal(requests.length, before);
});

test('Streamable HTTP initializes and calls tools; browser origins and rebinding are refused', async (t) => {
  const api = new AuthoringApi('http://127.0.0.1:8080', 'dev:me', async () => Response.json({ projects: [] }));
  const http = createLocalHttpServer(api);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: 'http-test', version: '1' });
  t.after(async () => { await client.close(); await new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections(); }); });
  await client.connect(new StreamableHTTPClientTransport(url));
  assert.equal((await client.listTools()).tools.length, 6);
  const result = await client.callTool({ name: 'list_applets', arguments: {} });
  assert.deepEqual(result.structuredContent, { projects: [] });
  assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(url)).status, 405);
});

test('transport failures do not leak credentials into tool errors', async () => {
  const api = new AuthoringApi('http://127.0.0.1:8080', 'dev:secret', async () => { throw new Error('dev:secret'); });
  await assert.rejects(api.request('projects'), (error: Error) => !JSON.stringify(error).includes('dev:secret'));
});


test('Node entrypoint speaks stdio MCP without stdout banners', async (t) => {
  const backend = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer dev:stdio');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ projects: [] }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const address = backend.address();
  assert.ok(address && typeof address === 'object');
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./main.ts', import.meta.url))],
    env: { ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}), JUNCTION26_API_ORIGIN: `http://127.0.0.1:${address.port}`, JUNCTION26_AUTHORING_TOKEN: 'dev:stdio' },
  });
  t.after(async () => { await client.close(); await new Promise<void>((resolve) => { backend.close(() => resolve()); backend.closeAllConnections(); }); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 6);
  assert.deepEqual((await client.callTool({ name: 'list_applets', arguments: {} })).structuredContent, { projects: [] });
});
