import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionConfig } from './pool.ts';

const ca = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

test('without a CA, the URL (and its sslmode) is used as given', () => {
  const url = 'postgres://u:p@db.example.com:5432/app?sslmode=require';
  assert.deepEqual(connectionConfig(url), { connectionString: url });
});

test('a CA replaces URL TLS parameters with verified TLS', () => {
  const config = connectionConfig('postgres://u:p@db.example.com:5432/app?sslmode=require&uselibpqcompat=true&application_name=x', ca);
  assert.equal(config.connectionString, 'postgres://u:p@db.example.com:5432/app?application_name=x');
  assert.deepEqual(config.ssl, { ca, rejectUnauthorized: true });
});
