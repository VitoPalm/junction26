import { loadConfig, silentLogger } from '@junction26/server-common';
import { MemoryObjectStore } from '@junction26/storage';
import { createTestDatabase, type TestDatabase } from '@junction26/db/testing';
import { createApp } from '../app.ts';

export interface Harness {
  db: TestDatabase;
  store: MemoryObjectStore;
  app: ReturnType<typeof createApp>;
  /** JSON request helper; `token` becomes a Bearer header. */
  call(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
}

export async function createHarness(env: Record<string, string> = {}): Promise<Harness> {
  const db = await createTestDatabase();
  const store = new MemoryObjectStore();
  const config = loadConfig({
    DATABASE_URL: db.url,
    SESSION_SECRET: 'test-secret-'.padEnd(40, 'x'),
    STORAGE_DRIVER: 'memory',
    NODE_ENV: 'test',
    ...env,
  });
  const app = createApp({ config, pool: db.pool, store, logger: silentLogger });
  return {
    db,
    store,
    app,
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      let body: RequestInit['body'];
      if (opts.body instanceof Uint8Array || typeof opts.body === 'string') body = opts.body as RequestInit['body'];
      else if (opts.body !== undefined) {
        body = JSON.stringify(opts.body);
        headers['content-type'] ??= 'application/json';
      }
      const res = await app.request(path, { method, headers, body });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {}
      return { status: res.status, body: parsed, headers: res.headers };
    },
    close: () => db.drop(),
  };
}
