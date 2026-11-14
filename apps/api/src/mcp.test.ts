import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES } from '@junction26/applet-format';
import { skipWithoutDatabase } from '@junction26/db/testing';
import { createHarness, type Harness } from './test-support/harness.ts';
import { clerkEnv, clerkIssuer, clerkToken } from './test-support/clerk.ts';
import { clerkMcpVerifier } from './mcp-auth.ts';
import { scopedAuthoringBackend } from './mcp.ts';
import { loadConfig, silentLogger } from '@junction26/server-common';
import { AuthoringApiError } from '@junction26/assistant-mcp/api';

const resource = 'http://127.0.0.1:8080/mcp';
const env = { ...clerkEnv, CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('auth.junction26.example$').toString('base64')}`, MCP_RESOURCE_URL: resource };
function oauth(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  return clerkToken({ sid: undefined, azp: undefined, aud: resource, client_id: 'client_test', jti: 'oat_test', scope: 'applets:read applets:draft', ...overrides }, { typ: 'at+jwt', cat: undefined, ...header });
}

describe('Clerk hosted MCP boundary', { skip: skipWithoutDatabase }, () => {
  let h: Harness;
  before(async () => { h = await createHarness(env); });
  after(async () => { await h?.close(); });
  async function rpc(token: string | null, method: string, params: unknown = {}) {
    return h.call('POST', '/mcp', {
      ...(token ? { token } : {}), headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' },
      body: { jsonrpc: '2.0', id: 1, method, params },
    });
  }
  const tool = (token: string, name: string, args: unknown = {}) => rpc(token, 'tools/call', { name, arguments: args });
  const data = (response: Awaited<ReturnType<typeof tool>>) => response.body.result.structuredContent;

  test('discovery is public and authentication challenges identify the canonical resource', async () => {
    const metadata = await h.call('GET', '/.well-known/oauth-protected-resource/mcp');
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.resource, resource);
    assert.deepEqual(metadata.body.authorization_servers, [clerkIssuer]);
    assert.deepEqual(metadata.body.scopes_supported, ['applets:read', 'applets:draft']);
    const unauthorized = await rpc(null, 'tools/list');
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
    assert.equal((await h.call('GET', '/mcp')).status, 405);
    assert.equal((await h.call('POST', '/mcp', { headers: { host: 'evil.example' }, body: {} })).status, 403);
    assert.equal((await h.call('POST', '/mcp', { headers: { origin: 'https://evil.example' }, body: {} })).status, 403);
  });

  test('signed OAuth tokens pass; sessions, wrong audiences/issuer, expired and forged tokens fail closed', async () => {
    assert.equal((await rpc(oauth(), 'tools/list')).body.result.tools.length, 6);
    for (const [index, token] of [
      clerkToken(), 'dev:me', 'j26d_fake', oauth({ aud: undefined }), oauth({ aud: 'https://other.example/mcp' }),
      oauth({ iss: 'https://other.example' }), oauth({ exp: 1 }), oauth({ exp: undefined }), oauth({ nbf: Math.floor(Date.now() / 1000) + 600 }), oauth({ sub: 'mch_robot' }), oauth({ client_id: undefined }),
      oauth().slice(0, -15) + 'invalid',
    ].entries()) assert.equal((await rpc(token, 'tools/list')).status, 401, `rejected token case ${index}`);
    const insufficient = await rpc(oauth({ scope: 'profile email' }), 'tools/list');
    assert.equal(insufficient.status, 403);
    assert.match(insufficient.headers.get('www-authenticate')!, /scope="applets:read"/);
  });

  test('same Clerk account owns web and MCP drafts; concurrent callers stay isolated', async () => {
    const tokens = [oauth({ sub: 'user_mcp_alice' }), oauth({ sub: 'user_mcp_bob' })];
    const responses = await Promise.all(tokens.map((token) => tool(token, 'create_applet', { title: 'MCP counter', definition: FIXTURES.rowCounter, operationId: 'shared-operation-id' })));
    const [alice, bob] = responses.map(data);
    assert.notEqual(alice.project.id, bob.project.id);
    const replay = data(await tool(tokens[0]!, 'create_applet', { title: 'MCP counter', definition: FIXTURES.rowCounter, operationId: 'shared-operation-id' }));
    assert.equal(replay.revision.id, alice.revision.id);
    const web = await h.call('GET', '/v1/projects', { token: clerkToken({ sub: 'user_mcp_alice' }) });
    assert.ok(web.body.projects.some((p: { id: string }) => p.id === alice.project.id));
    assert.ok(!web.body.projects.some((p: { id: string }) => p.id === bob.project.id));
    const foreign = await tool(tokens[1]!, 'get_applet', { projectId: alice.project.id, revisionId: alice.revision.id });
    assert.equal(data(foreign).status, 404);
    const readOnly = await tool(oauth({ scope: 'applets:read' }), 'create_applet', { title: 'No write', definition: FIXTURES.rowCounter, operationId: 'read-only-create' });
    assert.equal(data(readOnly).status, 403);
    assert.match(readOnly.body.result._meta['mcp/www_authenticate'][0], /applets:draft/);
  });

  test('OAuth credentials cannot call ordinary API routes or turn into full user sessions', async () => {
    const token = oauth();
    for (const [method, path, body] of [
      ['GET', '/v1/projects', undefined], ['POST', '/v1/projects', { title: 'No' }],
      ['POST', '/v1/devices/pairing-codes', {}], ['GET', '/v1/devices', undefined],
      ['POST', '/v1/uploads', {}], ['POST', '/v1/projects/00000000-0000-4000-8000-000000000001/releases', {}],
      ['GET', '/v1/projects/00000000-0000-4000-8000-000000000001/state', undefined],
      ['POST', '/v1/projects/00000000-0000-4000-8000-000000000001/messages', { text: 'No managed generation' }],
    ] as const) assert.equal((await h.call(method, path, { token, body })).status, 401);
    const config = loadConfig({ DATABASE_URL: h.db.url, SESSION_SECRET: 'x'.repeat(32), STORAGE_DRIVER: 'memory', ...env });
    const deps = { config, pool: h.db.pool, store: h.store, logger: silentLogger };
    const principal = await clerkMcpVerifier(deps)(new Request(resource, { headers: { authorization: `Bearer ${token}` } }));
    assert.ok(principal);
    const backend = scopedAuthoringBackend(deps, principal);
    for (const path of ['uploads', 'devices', 'projects/abc/state', 'projects/abc/messages', 'projects/abc/releases', '../v1/me']) {
      await assert.rejects(backend.request(path, { body: {} }), (err) => err instanceof AuthoringApiError && err.status === 403);
    }
  });
});
