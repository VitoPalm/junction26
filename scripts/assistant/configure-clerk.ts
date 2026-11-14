/** Idempotent Clerk OAuth bootstrap. No secrets or token responses are printed. */
const secret = process.env.CLERK_SECRET_KEY;
if (!secret) throw new Error('Load .env.backend.local first');
const desired = {
  aud_claim_enabled: true,
  pkce_required: true,
  dynamic_oauth_client_registration: true,
  client_id_metadata_documents_advertised: true,
  dynamic_client_allowed_scopes: ['applets:read', 'applets:draft', 'offline_access'],
  default_scopes: ['applets:read', 'applets:draft'],
};
const url = 'https://api.clerk.com/v1/instance/oauth_application_settings';
const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, desired }, null, 2));
} else {
  const response = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(desired), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    // Deliberately omit the raw provider response, which may contain internals.
    throw new Error(`Clerk configuration failed (${response.status}). Create and advertise applets:read and applets:draft in OAuth Applications > Scopes, then retry.`);
  }
  const saved = await response.json() as Record<string, unknown>;
  for (const [key, value] of Object.entries(desired)) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(value)) throw new Error(`Clerk did not persist the requested ${key} setting`);
  }
  console.log('Clerk MCP settings verified: audience binding, PKCE S256, CIMD/DCR and applet read/draft scopes.');
}
export {};
