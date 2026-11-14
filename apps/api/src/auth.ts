import { createHmac, randomBytes, randomInt } from 'node:crypto';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { authenticateDevice, upsertUserByExternalId } from '@junction26/db';
import { clerkUserExternalId } from './clerk.ts';
import type { AppEnv, Deps, Principal } from './context.ts';
import { ApiError, forbidden } from './errors.ts';

/**
 * Authentication.
 *
 * User sessions: AUTH_MODE=clerk verifies first-party Clerk session JWTs.
 * AUTH_MODE=dev accepts `Bearer dev:<name>` locally and is refused in production.
 * Delegated OAuth credentials are not accepted as full authoring sessions.
 *
 * Device sessions are real: opaque random tokens issued by pairing, stored only
 * as an HMAC keyed with SESSION_SECRET, revocable per device.
 */

export const DEVICE_TOKEN_PREFIX = 'j26d_';
const DEV_SUBJECT = /^[A-Za-z0-9_-]{1,64}$/;

// Unambiguous characters (no 0/O, 1/I/L) for codes people type.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export function hmac(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${value}`).digest('hex');
}

export function newDeviceToken(): string {
  return DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** 8 characters, shown as XXXX-XXXX; about 40 bits, valid for 10 minutes, one use. */
export function newPairingCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

async function resolvePrincipal(deps: Deps, token: string): Promise<Principal | null> {
  if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
    const device = await authenticateDevice(deps.pool, hmac(deps.config.sessionSecret, 'device', token));
    return device ? { kind: 'device', userId: device.ownerId, deviceId: device.id } : null;
  }
  return resolveUser(deps, token);
}

async function resolveUser(deps: Deps, token: string): Promise<Principal | null> {
  if (deps.config.authMode === 'clerk' && deps.config.clerk) {
    const externalId = await clerkUserExternalId(token, deps.config.clerk);
    if (!externalId) return null;
    const user = await upsertUserByExternalId(deps.pool, externalId);
    return { kind: 'user', userId: user.id };
  }
  if (deps.config.authMode === 'dev' && token.startsWith('dev:')) {
    const subject = token.slice(4);
    if (!DEV_SUBJECT.test(subject)) return null;
    const user = await upsertUserByExternalId(deps.pool, `dev:${subject}`, subject);
    return { kind: 'user', userId: user.id };
  }
  return null;
}

/** Requires any valid session and sets `principal`. */
export function authenticate(deps: Deps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      throw new ApiError(401, 'unauthenticated', 'Send Authorization: Bearer <token>');
    }
    const principal = await resolvePrincipal(deps, match[1]!);
    if (!principal) throw new ApiError(401, 'unauthenticated', 'The session token is invalid or revoked');
    c.set('principal', principal);
    c.set('log', c.get('log').child({ userId: principal.userId, ...(principal.kind === 'device' ? { deviceId: principal.deviceId } : {}) }));
    await next();
  });
}

/** Authoring endpoints: refuse device sessions. */
export function requireUser(p: Principal): asserts p is Extract<Principal, { kind: 'user' }> {
  if (p.kind !== 'user') throw forbidden('This endpoint needs an authoring (user) session, not a device session');
}

export function requireDevice(p: Principal): asserts p is Extract<Principal, { kind: 'device' }> {
  if (p.kind !== 'device') throw forbidden('This endpoint needs a paired device session');
}

/** The calling user's ID; refuses device sessions. */
export function authorId(c: Context<AppEnv>): string {
  const p = c.get('principal');
  requireUser(p);
  return p.userId;
}

/** Delegated principals exist only behind /mcp; regular user APIs refuse them. */
export function assistantAuthorId(c: Context<AppEnv>, scope: 'applets:read' | 'applets:draft'): string {
  const p = c.get('principal');
  if (p.kind === 'assistant') {
    if (!p.scopes.includes(scope)) throw new ApiError(403, 'insufficient_scope', `This operation requires ${scope}`);
    return p.userId;
  }
  return authorId(c);
}
