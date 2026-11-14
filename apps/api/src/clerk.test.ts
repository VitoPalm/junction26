import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@junction26/server-common';
import { clerkUserExternalId } from './clerk.ts';
import { clerkEnv, clerkIssuer, clerkToken } from './test-support/clerk.ts';

const config = loadConfig({ DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32), STORAGE_DRIVER: 'memory', ...clerkEnv }).clerk!;

test('Clerk sessions map stable issuer/user identity independently of session or email', async () => {
  const expected = `clerk:${JSON.stringify([clerkIssuer, 'user_alice'])}`;
  assert.equal(await clerkUserExternalId(clerkToken(), config), expected);
  assert.equal(await clerkUserExternalId(clerkToken({ sid: 'sess_new', email: 'changed@example.com', sts: 'active' }), config), expected);
  assert.notEqual(await clerkUserExternalId(clerkToken({ sub: 'user_bob' }), config), expected);
});

test('Clerk rejects forged, expired, premature, wrong-issuer and wrong-origin tokens', async () => {
  const valid = clerkToken();
  for (const token of [
    'dev:alice', 'oat_not-a-session', 'ak_not-a-session', 'mt_not-a-session', 'not-a-jwt',
    `${valid.slice(0, valid.lastIndexOf('.') + 1)}forged`,
    clerkToken({ exp: 1 }), clerkToken({ exp: undefined }),
    clerkToken({ nbf: Math.floor(Date.now() / 1000) + 600 }),
    clerkToken({ iss: 'https://other.clerk.accounts.dev' }),
    clerkToken({ azp: 'https://evil.example' }), clerkToken({ azp: undefined }),
    clerkToken({ sub: 'mch_machine' }), clerkToken({ sid: undefined }),
    clerkToken({ sts: 'pending' }),
    clerkToken({}, { typ: 'at+jwt' }), clerkToken({}, { typ: 'application/at+jwt' }),
    clerkToken({}, { cat: 'oauth_access_token' }),
  ]) assert.equal(await clerkUserExternalId(token, config), null);
});
