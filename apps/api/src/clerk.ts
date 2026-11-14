import { verifyToken } from '@clerk/backend';
import type { Config } from '@junction26/server-common';

/** Only first-party Clerk sessions. OAuth/M2M credentials must never gain full user permissions. */
export async function clerkUserExternalId(token: string, config: NonNullable<Config['clerk']>): Promise<string | null> {
  try {
    const claims = await verifyToken(token, {
      issuer: config.issuer,
      authorizedParties: config.authorizedParties,
      secretKey: config.secretKey,
      jwtKey: config.jwtKey,
      headerType: 'JWT',
    });
    // azp is optional in the SDK; require it here. A session also needs a real
    // user and session ID, and must have completed pending account tasks.
    if (typeof claims.sub !== 'string' || !claims.sub.startsWith('user_') ||
        typeof claims.sid !== 'string' || !claims.sid.startsWith('sess_') ||
        typeof claims.azp !== 'string' || !config.authorizedParties.includes(claims.azp) ||
        (claims.sts !== undefined && claims.sts !== 'active')) return null;
    // JSON encodes the tuple unambiguously and isolates development/production instances.
    return `clerk:${JSON.stringify([config.issuer, claims.sub])}`;
  } catch {
    // SDK errors may contain token details. Never propagate or log them.
    return null;
  }
}
