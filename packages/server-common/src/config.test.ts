import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from './config.ts';
import { checkDefinition } from './definition.ts';

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
