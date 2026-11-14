/** Explicit interactive smoke test: creates one owned counter draft. No model calls.
 * OAuth tokens, authorization code and PKCE verifier live only in process memory.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { FIXTURES } from '@junction26/applet-format';

const resource = process.env.MCP_RESOURCE_URL;
if (!resource) throw new Error('Set MCP_RESOURCE_URL');
let info: OAuthClientInformationMixed | undefined;
let tokens: OAuthTokens | undefined;
let verifier = '';
const state = randomUUID();
const redirectUrl = 'http://127.0.0.1:8091/callback';
await mkdir('.data/mcp-smoke', { recursive: true });
let receiveCode: (code: string) => void;
const code = new Promise<string>((resolve) => { receiveCode = resolve; });
const callback = createServer((req, res) => {
  const url = new URL(req.url ?? '/', redirectUrl);
  if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
    res.writeHead(400).end('Invalid OAuth callback'); return;
  }
  receiveCode(url.searchParams.get('code')!);
  res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Junction26 OAuth connected. You may close this tab.');
});
await new Promise<void>((resolve, reject) => { callback.once('error', reject); callback.listen(8091, '127.0.0.1', resolve); });
const provider: OAuthClientProvider = {
  redirectUrl,
  clientMetadata: { client_name: 'Junction26 local MCP proof', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'applets:read applets:draft' },
  state: () => state,
  clientInformation: () => info,
  saveClientInformation: (value) => { info = value; },
  tokens: () => tokens,
  saveTokens: (value) => { tokens = value; },
  saveCodeVerifier: (value) => { verifier = value; },
  codeVerifier: () => verifier,
  redirectToAuthorization: async (url) => {
    await writeFile('.data/mcp-smoke/authorization-url.txt', url.href, { mode: 0o600 });
    console.log('Authorization URL ready in .data/mcp-smoke/authorization-url.txt. Open it in the signed-in browser.');
  },
};
const client = new Client({ name: 'junction26-oauth-proof', version: '0.1.0' });
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const result = await auth(provider, { serverUrl: resource, scope: 'applets:read applets:draft' });
  if (result !== 'AUTHORIZED') {
    const authorizationCode = await Promise.race([code, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('OAuth consent timed out')), 5 * 60_000); })]);
    clearTimeout(timer);
    if (await auth(provider, { serverUrl: resource, authorizationCode }) !== 'AUTHORIZED') throw new Error('OAuth exchange did not complete');
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider }));
  const listed = await client.listTools();
  const checked = await client.callTool({ name: 'validate_applet', arguments: { definition: FIXTURES.rowCounter } });
  if (checked.isError || !(checked.structuredContent as { valid?: boolean })?.valid) throw new Error('Validation proof failed');
  const created = await client.callTool({ name: 'create_applet', arguments: { title: 'MCP OAuth proof', definition: FIXTURES.rowCounter, operationId: randomUUID() } });
  if (created.isError) throw new Error('Draft proof failed');
  const saved = created.structuredContent as { project: { id: string }; revision: { id: string }; previewUrl: string };
  const receipt = { verifiedAt: new Date().toISOString(), transport: 'local HTTP with real Clerk OAuth', tools: listed.tools.map((tool) => tool.name), projectId: saved.project.id, revisionId: saved.revision.id, previewUrl: saved.previewUrl, published: false };
  await writeFile('.data/mcp-smoke/result.json', JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
} catch {
  // SDK OAuth failures can include raw token responses. Never print them.
  console.error('OAuth smoke test failed. No credentials were printed. Check Clerk configuration and consent.');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close();
  callback.close(); callback.closeAllConnections();
}
