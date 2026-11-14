import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from './config.ts';
import { checkDefinition } from './definition.ts';
import { generateKeyPairSync } from 'node:crypto';

const base = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32), STORAGE_DRIVER: 'memory' };

test('loads defaults', () => {
  const c = loadConfig(base);
  assert.equal(c.port, 8080);
  assert.equal(c.storage.driver, 'memory');
  assert.equal(c.model.model, 'openai/gpt-6-luna');
  assert.equal(c.limits.maxUploadBytes, 50 * 1024 * 1024);
});

test('empty strings count as unset', () => {
  const c = loadConfig({ ...base, PORT: '', OPENROUTER_API_KEY: '' });
  assert.equal(c.port, 8080);
  assert.equal(c.model.apiKey, undefined);
});

test('s3 driver requires credentials and lists all missing variables', () => {
  assert.throws(
    () => loadConfig({ ...base, STORAGE_DRIVER: 's3' }),
    (e: unknown) => e instanceof ConfigError && /AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY/.test(e.message),
  );
});

test('production refuses dev auth and non-s3 storage', () => {
  assert.throws(
    () => loadConfig({ ...base, NODE_ENV: 'production' }),
    (e: unknown) => e instanceof ConfigError && e.problems.length === 2,
  );
});

test('short session secret is rejected', () => {
  assert.throws(() => loadConfig({ ...base, SESSION_SECRET: 'short' }), ConfigError);
});

const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
const clerk = { AUTH_MODE: 'clerk', CLERK_ISSUER: 'https://auth.example.com', CLERK_AUTHORIZED_PARTIES: 'https://example.com', CLERK_JWT_KEY: publicKey };

test('production accepts configured Clerk and S3, with escaped PEM newlines', () => {
  const c = loadConfig({ ...base, ...clerk, CLERK_JWT_KEY: publicKey.replace(/\n/g, '\\n'), NODE_ENV: 'production', STORAGE_DRIVER: 's3',
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_ENDPOINT_URL: 'https://s3.example.com', AWS_REGION: 'test', VERDA_S3_BUCKET: 'test' });
  assert.equal(c.authMode, 'clerk');
  assert.equal(c.clerk?.jwtKey, publicKey);
  assert.deepEqual(c.clerk?.authorizedParties, ['https://example.com']);
});

test('Clerk configuration fails closed for missing verification settings or unsafe origins', () => {
  for (const env of [
    { AUTH_MODE: 'clerk' },
    { ...clerk, CLERK_ISSUER: 'http://auth.example.com' },
    { ...clerk, CLERK_JWT_KEY: 'not a key' },
    { ...clerk, CLERK_JWT_KEY: '' },
    { ...clerk, CLERK_AUTHORIZED_PARTIES: '' },
    { ...clerk, CLERK_AUTHORIZED_PARTIES: '*' },
    { ...clerk, CLERK_AUTHORIZED_PARTIES: 'https://example.com/path' },
    { ...clerk, CLERK_AUTHORIZED_PARTIES: 'http://example.com' },
    { ...clerk, NODE_ENV: 'production', CLERK_AUTHORIZED_PARTIES: 'http://localhost:5173' },
    { ...clerk, NODE_ENV: 'production', CLERK_ISSUER: 'https://example.clerk.accounts.dev' },
  ]) assert.throws(() => loadConfig({ ...base, ...env }), ConfigError);
  assert.equal(loadConfig({ ...base, ...clerk, CLERK_AUTHORIZED_PARTIES: 'http://localhost:5173' }).authMode, 'clerk');
  assert.equal(loadConfig({ ...base, ...clerk, CLERK_JWT_KEY: '', CLERK_SECRET_KEY: 'sk_test_example' }).authMode, 'clerk');
});

test('production accepts a Clerk development instance only with the explicit opt-in', () => {
  const s3 = { STORAGE_DRIVER: 's3', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_ENDPOINT_URL: 'https://s3.example.com', AWS_REGION: 'r', VERDA_S3_BUCKET: 'b' };
  const devInstance = { ...clerk, ...s3, NODE_ENV: 'production', CLERK_ISSUER: 'https://example.clerk.accounts.dev', CLERK_JWT_KEY: '', CLERK_SECRET_KEY: 'sk_test_example' };
  assert.throws(() => loadConfig({ ...base, ...devInstance }), ConfigError);
  assert.equal(loadConfig({ ...base, ...devInstance, CLERK_ALLOW_DEVELOPMENT_INSTANCE: 'true' }).authMode, 'clerk');
  assert.throws(() => loadConfig({ ...base, ...devInstance, CLERK_ALLOW_DEVELOPMENT_INSTANCE: 'true', CLERK_AUTHORIZED_PARTIES: 'http://localhost:5173' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, ...s3, NODE_ENV: 'production', AUTH_MODE: 'dev', CLERK_ALLOW_DEVELOPMENT_INSTANCE: 'true' }), ConfigError);
});

test('DATABASE_CA_CERT accepts PEM with escaped newlines and rejects anything else', () => {
  const pem = '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
  assert.equal(loadConfig({ ...base, DATABASE_CA_CERT: pem }).databaseCaCert, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----');
  assert.equal(loadConfig(base).databaseCaCert, undefined);
  assert.throws(() => loadConfig({ ...base, DATABASE_CA_CERT: 'not a cert' }), ConfigError);
});

test('checkDefinition accepts minimal definitions and reports every issue', () => {
  assert.deepEqual(checkDefinition({ formatVersion: 1, title: 'Row counter' }, 1000), {
    ok: true,
    formatVersion: 1,
    minimumRuntimeVersion: null,
    title: 'Row counter',
  });
  const bad = checkDefinition({ formatVersion: 9, title: '', minimumRuntimeVersion: 'x' }, 1000);
  assert.equal(bad.ok, false);
  assert.deepEqual(
    !bad.ok && bad.issues.map((i) => i.path),
    ['$.formatVersion', '$.title', '$.minimumRuntimeVersion'],
  );
  assert.equal(checkDefinition([], 1000).ok, false);
  assert.equal(checkDefinition({ formatVersion: 1, title: 'x', pad: 'y'.repeat(100) }, 50).ok, false);
});

test('hosted MCP requires explicit Clerk settings and an exact canonical resource', () => {
  const enabled = { ...base, ...clerk, CLERK_SECRET_KEY: 'sk_test_example', CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('auth.example.com$').toString('base64')}`, MCP_RESOURCE_URL: 'http://127.0.0.1:8080/mcp' };
  assert.equal(loadConfig(enabled).mcp?.resourceUrl, enabled.MCP_RESOURCE_URL);
  assert.equal(loadConfig({ ...base, ...clerk }).mcp, undefined);
  for (const env of [
    { AUTH_MODE: 'dev' }, { CLERK_SECRET_KEY: '' }, { CLERK_PUBLISHABLE_KEY: '' },
    { MCP_RESOURCE_URL: 'http://external.example/mcp' },
    { MCP_RESOURCE_URL: 'https://external.example/mcp/' },
    { MCP_RESOURCE_URL: 'https://external.example/mcp?q=1' },
    { MCP_RESOURCE_URL: 'https://user:pass@external.example/mcp' },
    { NODE_ENV: 'production' },
  ]) assert.throws(() => loadConfig({ ...enabled, ...env }), ConfigError);
});
