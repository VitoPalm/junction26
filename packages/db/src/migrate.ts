import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type pg from 'pg';
import { createPool } from './pool.ts';

/** `packages/db/migrations`, resolved from both src/ and dist/. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

// Arbitrary constant; every process that migrates takes the same lock.
const MIGRATION_LOCK_KEY = 726_026_001;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

/**
 * Applies pending migrations in filename order, each in its own transaction,
 * under a session-level advisory lock so concurrent starters (API replicas,
 * worker) never migrate at the same time. Refuses to run if an applied
 * migration's file has changed.
 *
 * Use a direct (non-PgBouncer) connection: session advisory locks don't work
 * through transaction pooling.
 */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = await readMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name        text PRIMARY KEY,
          checksum    text NOT NULL,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM schema_migrations',
      );
      const done = new Map(rows.map((r) => [r.name, r.checksum]));
      const known = new Set(files.map((f) => f.name));
      const unknown = [...done.keys()].filter((n) => !known.has(n));
      if (unknown.length) {
        throw new Error(`Database has migrations this build doesn't know: ${unknown.join(', ')} (deploying an older build?)`);
      }

      const result: MigrationResult = { applied: [], alreadyApplied: [] };
      for (const file of files) {
        const previous = done.get(file.name);
        if (previous !== undefined) {
          if (previous !== file.checksum) {
            throw new Error(`Migration ${file.name} changed after it was applied; add a new migration instead`);
          }
          result.alreadyApplied.push(file.name);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`, { cause: err });
        }
        result.applied.push(file.name);
      }
      return result;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** Migrates over a dedicated one-connection pool (use the direct, non-pooled URL). */
export async function migrateUrl(connectionString: string, options: { caCert?: string } = {}): Promise<MigrationResult> {
  const pool = createPool(connectionString, { max: 1, applicationName: 'junction26-migrate', caCert: options.caCert });
  try {
    return await migrate(pool);
  } finally {
    await pool.end();
  }
}
