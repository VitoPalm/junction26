import pg from 'pg';

// int8 (bigint) arrives as a string by default. Our bigints are byte sizes and
// device sequences, far below 2^53, so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds the safe integer range`);
  return n;
});

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface PoolOptions {
  max?: number;
  applicationName?: string;
  /**
   * PEM CA certificate(s) that sign the server certificate (Aiven uses a
   * per-project CA). When set, TLS is required and fully verified against this
   * CA, and any `ssl*` parameters in the URL are ignored.
   */
  caCert?: string;
}

/**
 * Creates a connection pool. Without `caCert`, TLS settings come from the URL
 * (`sslmode=...`), as injected by the Aiven service integration. Statements are
 * unnamed, so the pool works behind PgBouncer transaction pooling.
 */
export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    ...connectionConfig(connectionString, options.caCert),
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'junction26',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client erroring (e.g. server restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

/**
 * node-postgres lets URL parameters override the `ssl` option, so a custom CA
 * requires removing them from the URL.
 */
export function connectionConfig(connectionString: string, caCert?: string): pg.PoolConfig {
  if (!caCert) return { connectionString };
  const url = new URL(connectionString);
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('ssl') || key === 'uselibpqcompat') url.searchParams.delete(key);
  }
  return { connectionString: url.toString(), ssl: { ca: caCert, rejectUnauthorized: true } };
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
