import { serve } from '@hono/node-server';
import { createPool, migrateUrl } from '@junction26/db';
import { createObjectStore } from '@junction26/storage';
import { createLogger, loadConfig, onShutdown } from '@junction26/server-common';
import { createApp } from './app.ts';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, bindings: { service: 'api' } });
const pool = createPool(config.databaseUrl, { max: config.databasePoolMax, applicationName: 'junction26-api', caCert: config.databaseCaCert });
const store = createObjectStore(config.storage);

if (config.migrateOnStart) {
  // Guarded by an advisory lock, so concurrent starters are safe.
  const result = await migrateUrl(config.migrationDatabaseUrl, { caCert: config.databaseCaCert });
  logger.info('migrations checked', { applied: result.applied });
}

const app = createApp({ config, pool, store, logger });
const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  logger.info('listening', { port: info.port, storage: store.driver, authMode: config.authMode });
});

onShutdown(logger, config.shutdownGraceMs, async () => {
  // Stop accepting connections, let in-flight requests finish, then close the pool.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
