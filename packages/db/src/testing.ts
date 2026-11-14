import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, type Pool } from './pool.ts';
import { migrate } from './migrate.ts';

/**
 * Integration-test helper: creates a fresh, migrated database per call on the
 * server named by TEST_DATABASE_URL, and drops it afterwards. Run
 * `npm run dev:db` (podman) to get a local server; see docs/backend-development.md.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Use as `test(name, { skip: skipWithoutDatabase }, fn)`. */
export const skipWithoutDatabase: string | false = TEST_DATABASE_URL
  ? false
  : 'TEST_DATABASE_URL is not set (run `npm run dev:db`, then export the URL it prints)';

export interface TestDatabase {
  pool: Pool;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const name = `j26_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), { max: 8, applicationName: 'junction26-test' });
  await migrate(pool);
  return {
    pool,
    url: url.toString(),
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
