import { createServer } from 'node:http';
import { createPool, migrateUrl } from '@junction26/db';
import { createObjectStore } from '@junction26/storage';
import { createLogger, loadConfig, onShutdown } from '@junction26/server-common';
import { JobRunner } from './runner.ts';
import { createHandlers } from './handlers.ts';
import { modelRegistryFromConfig } from './generate.ts';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, bindings: { service: 'worker' } });
const pool = createPool(config.databaseUrl, { max: config.worker.concurrency + 2, applicationName: 'junction26-worker' });
const store = createObjectStore(config.storage);

if (config.migrateOnStart) {
  const result = await migrateUrl(config.migrationDatabaseUrl);
  logger.info('migrations checked', { applied: result.applied });
}

const models = modelRegistryFromConfig(config);
logger.info('authoring models', { default: config.model.model, allowed: config.model.allowed });
const runner = new JobRunner({ config, pool, store, logger }, createHandlers(models), {
  ...(config.worker.id ? { workerId: config.worker.id } : {}),
  concurrency: config.worker.concurrency,
  generationConcurrency: config.limits.generationConcurrency,
  pollMs: config.worker.pollMs,
  leaseMs: config.worker.leaseMs,
});
runner.start();

// Optional liveness endpoint, for hosts that require every app to listen on a
// port (see docs/infrastructure-setup.md, Aiven Runtime worker assumption).
const health = config.worker.healthPort
  ? createServer((req, res) => {
      const stale = Date.now() - runner.lastTickAt > Math.max(30_000, config.worker.pollMs * 10);
      res.writeHead(req.url === '/healthz' && !stale ? 200 : req.url === '/healthz' ? 503 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: !stale, active: runner.activeCount }));
    }).listen(config.worker.healthPort, '0.0.0.0')
  : null;

onShutdown(logger, config.shutdownGraceMs, async () => {
  health?.close();
  await runner.stop(Math.max(0, config.shutdownGraceMs - 5000));
  await pool.end();
});
