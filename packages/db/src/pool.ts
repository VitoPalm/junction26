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
}

/**
 * Creates a connection pool. TLS settings come from the URL (`sslmode=...`), as
 * injected by the Aiven service integration. Statements are unnamed, so the
 * pool works behind PgBouncer transaction pooling.
 */
export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'junction26',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client erroring (e.g. server restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
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
