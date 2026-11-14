import { z } from 'zod';

/**
 * Environment contract for the API and the worker. Every variable is documented
 * in docs/infrastructure-setup.md ("Full environment contract"). Parsing fails
 * fast with one message listing every problem, so a bad deploy never half-starts.
 */

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const positiveInt = z.coerce.number().int().positive();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: positiveInt.default(8080),
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: positiveInt.default(10),
  MIGRATE_ON_START: bool.default(false),

  STORAGE_DRIVER: z.enum(['s3', 'fs', 'memory']).default('s3'),
  STORAGE_FS_ROOT: z.string().default('.data/objects'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_REGION: z.string().optional(),
  VERDA_S3_BUCKET: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),

  AUTH_MODE: z.enum(['dev']).default('dev'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:8080'),

  MAX_UPLOAD_BYTES: positiveInt.default(50 * 1024 * 1024),
  MAX_DEFINITION_BYTES: positiveInt.default(512 * 1024),
  MAX_STATE_BYTES: positiveInt.default(256 * 1024),
  GENERATION_CONCURRENCY: positiveInt.default(2),
  MAX_OUTPUT_TOKENS: positiveInt.default(16_000),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  AUTHORING_MODEL: z.string().default('openai/gpt-6-luna'),

  WORKER_ID: z.string().optional(),
  WORKER_CONCURRENCY: positiveInt.default(2),
  WORKER_POLL_MS: positiveInt.default(1000),
  WORKER_LEASE_MS: positiveInt.default(60_000),
  WORKER_HEALTH_PORT: positiveInt.optional(),
  SHUTDOWN_GRACE_MS: positiveInt.default(20_000),
});

export type StorageConfig =
  | { driver: 'memory' }
  | { driver: 'fs'; root: string }
  | {
      driver: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  port: number;
  databaseUrl: string;
  /** Direct (non-PgBouncer) URL for migrations; falls back to databaseUrl. */
  migrationDatabaseUrl: string;
  databasePoolMax: number;
  migrateOnStart: boolean;
  storage: StorageConfig;
  authMode: 'dev';
  sessionSecret: string;
  publicOrigin: string;
  limits: {
    maxUploadBytes: number;
    maxDefinitionBytes: number;
    maxStateBytes: number;
    generationConcurrency: number;
    maxOutputTokens: number;
  };
  model: { apiKey: string | undefined; baseUrl: string; model: string };
  worker: {
    id: string | undefined;
    concurrency: number;
    pollMs: number;
    leaseMs: number;
    healthPort: number | undefined;
  };
  shutdownGraceMs: number;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings as unset so `KEY=` lines in .env files fall back to defaults.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`));
  }
  const e = parsed.data;
  const problems: string[] = [];

  let storage: StorageConfig;
  if (e.STORAGE_DRIVER === 's3') {
    const missing = (['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL', 'AWS_REGION', 'VERDA_S3_BUCKET'] as const).filter(
      (k) => !e[k],
    );
    if (missing.length) problems.push(`STORAGE_DRIVER=s3 requires ${missing.join(', ')}`);
    storage = {
      driver: 's3',
      endpoint: e.AWS_ENDPOINT_URL ?? '',
      region: e.AWS_REGION ?? '',
      bucket: e.VERDA_S3_BUCKET ?? '',
      accessKeyId: e.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    };
  } else if (e.STORAGE_DRIVER === 'fs') {
    storage = { driver: 'fs', root: e.STORAGE_FS_ROOT };
  } else {
    storage = { driver: 'memory' };
  }

  if (e.NODE_ENV === 'production') {
    // Dev auth trusts the bearer token as an identity. It must never face the internet.
    if (e.AUTH_MODE === 'dev') problems.push('AUTH_MODE=dev is refused when NODE_ENV=production (choose a real auth provider)');
    if (storage.driver !== 's3') problems.push(`STORAGE_DRIVER=${storage.driver} is refused when NODE_ENV=production`);
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    migrationDatabaseUrl: e.MIGRATION_DATABASE_URL ?? e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    migrateOnStart: e.MIGRATE_ON_START,
    storage,
    authMode: e.AUTH_MODE,
    sessionSecret: e.SESSION_SECRET,
    publicOrigin: e.PUBLIC_ORIGIN.replace(/\/$/, ''),
    limits: {
      maxUploadBytes: e.MAX_UPLOAD_BYTES,
      maxDefinitionBytes: e.MAX_DEFINITION_BYTES,
      maxStateBytes: e.MAX_STATE_BYTES,
      generationConcurrency: e.GENERATION_CONCURRENCY,
      maxOutputTokens: e.MAX_OUTPUT_TOKENS,
    },
    model: { apiKey: e.OPENROUTER_API_KEY, baseUrl: e.OPENROUTER_BASE_URL, model: e.AUTHORING_MODEL },
    worker: {
      id: e.WORKER_ID,
      concurrency: e.WORKER_CONCURRENCY,
      pollMs: e.WORKER_POLL_MS,
      leaseMs: e.WORKER_LEASE_MS,
      healthPort: e.WORKER_HEALTH_PORT,
    },
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
  };
}
