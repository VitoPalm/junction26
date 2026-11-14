import { generateKeyPairSync, sign } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const clerkIssuer = 'https://auth.junction26.example';
export const clerkOrigin = 'https://junction26.example';
export const clerkJwtKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
export const clerkEnv = {
  AUTH_MODE: 'clerk', CLERK_ISSUER: clerkIssuer,
  CLERK_AUTHORIZED_PARTIES: clerkOrigin, CLERK_JWT_KEY: clerkJwtKey,
};

/** Real RS256 signatures against a local test key; no Clerk service or paid calls. */
export function clerkToken(overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  // Current Clerk SDK requires its signed session category tag.
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key', cat: 'cl_B7d4PD111AAA', ...headerOverrides })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: clerkIssuer, sub: 'user_alice', sid: 'sess_alice', azp: clerkOrigin,
    iat: now, nbf: now - 5, exp: now + 60, ...overrides,
  })).toString('base64url');
  const content = `${header}.${payload}`;
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`;
}
