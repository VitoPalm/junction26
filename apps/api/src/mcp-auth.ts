import { createClerkClient } from '@clerk/backend';
import { upsertUserByExternalId } from '@junction26/db';
import type { Deps, Principal } from './context.ts';

export const MCP_SCOPES = ['applets:read', 'applets:draft'] as const;
export type AssistantPrincipal = Extract<Principal, { kind: 'assistant' }>;

/** A separate policy from first-party session verification. Never accepts cookies. */
export function clerkMcpVerifier(deps: Deps) {
  const { clerk, mcp } = deps.config;
  if (!clerk || !mcp) throw new Error('MCP auth is not configured');
  const client = createClerkClient({ secretKey: clerk.secretKey, publishableKey: mcp.publishableKey });
  return async (request: Request): Promise<AssistantPrincipal | null> => {
    const authorization = request.headers.get('authorization');
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return null;
    try {
      const state = await client.authenticateRequest(new Request(mcp.resourceUrl, { headers: { authorization } }), {
        acceptsToken: 'oauth_token', audience: mcp.resourceUrl, issuer: clerk.issuer,
        jwtKey: clerk.jwtKey,
      });
      if (!state.isAuthenticated) return null;
      // The current SDK's machine-token path does not enforce the issuer option
      // for JWTs. Inspect claims only AFTER successful signature/audience verification.
      const token = authorization.replace(/^Bearer\s+/i, '');
      if (token.split('.').length === 3) {
        const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
        if (claims.iss !== clerk.issuer || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
      }
      const auth = state.toAuth();
      if (!auth.isAuthenticated || auth.tokenType !== 'oauth_token' || !auth.userId?.startsWith('user_') || !auth.clientId) return null;
      const user = await upsertUserByExternalId(deps.pool, `clerk:${JSON.stringify([clerk.issuer, auth.userId])}`);
      return { kind: 'assistant', userId: user.id, clientId: auth.clientId, resource: mcp.resourceUrl, scopes: auth.scopes.filter((scope) => MCP_SCOPES.includes(scope as typeof MCP_SCOPES[number])) };
    } catch {
      // Clerk errors can contain credentials. Fail closed, without logging them.
      return null;
    }
  };
}
