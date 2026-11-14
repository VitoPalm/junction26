import { z } from 'zod';
import { createPublicKey } from 'node:crypto';

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

  AUTH_MODE: z.enum(['dev', 'clerk']).default('dev'),
  CLERK_ISSUER: z.string().url().optional(),
  CLERK_AUTHORIZED_PARTIES: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_JWT_KEY: z.string().optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:8080'),

  MAX_UPLOAD_BYTES: positiveInt.default(50 * 1024 * 1024),
  MAX_DEFINITION_BYTES: positiveInt.default(512 * 1024),
  MAX_STATE_BYTES: positiveInt.default(256 * 1024),
  GENERATION_CONCURRENCY: positiveInt.default(2),
  MAX_OUTPUT_TOKENS: positiveInt.default(16_000),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  /** Default authoring model spec ("provider:model"; a bare name means OpenRouter). */
  AUTHORING_MODEL: z.string().default('openai/gpt-6-luna'),
  /** Extra model specs users may pick, comma-separated. The default is always allowed. */
  AUTHORING_MODELS: z.string().optional(),
  AUTHORING_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).optional(),
  /** Any OpenAI-compatible endpoint, used by "openai:<model>" specs. */
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),

  /** Origins allowed to call the API from a browser (native app shells, dev servers), comma-separated. */
  CORS_ORIGINS: z.string().optional(),
  /** Directory holding the built web apps (glasses/ and author/), served by the API. */
  WEB_ROOT: z.string().optional(),

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
  authMode: 'dev' | 'clerk';
  clerk?: { issuer: string; authorizedParties: string[]; secretKey?: string; jwtKey?: string };
  sessionSecret: string;
  publicOrigin: string;
  limits: {
    maxUploadBytes: number;
    maxDefinitionBytes: number;
    maxStateBytes: number;
    generationConcurrency: number;
    maxOutputTokens: number;
  };
  model: {
    apiKey: string | undefined;
    baseUrl: string;
    /** Default model spec. */
    model: string;
    /** Every spec a user may choose (default first). */
    allowed: string[];
    reasoningEffort: 'low' | 'medium' | 'high' | undefined;
    openAI: { apiKey: string | undefined; baseUrl: string };
  };
  corsOrigins: string[];
  webRoot: string | undefined;
  worker: {
    id: string | undefined;
    concurrency: number;
    pollMs: number;
    leaseMs: number;
    healthPort: number | undefined;
  };
  shutdownGraceMs: number;
}

const list = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Capacitor shells (iOS: capacitor://localhost, Android: https://localhost) and Vite dev servers. */
const DEV_CORS_ORIGINS = [
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
];

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
  let clerk: Config['clerk'];
  if (e.AUTH_MODE === 'clerk') {
    const parties = list(e.CLERK_AUTHORIZED_PARTIES);
    if (!e.CLERK_ISSUER || new URL(e.CLERK_ISSUER).protocol !== 'https:') {
      problems.push('AUTH_MODE=clerk requires CLERK_ISSUER (the exact HTTPS issuer of your Clerk instance)');
    }
    if (!parties.length || parties.some((party) => {
      try {
        const url = new URL(party);
        return url.origin !== party || !(url.protocol === 'https:' ||
          (e.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
      } catch { return true; }
    })) problems.push('CLERK_AUTHORIZED_PARTIES requires exact HTTPS frontend origins (loopback HTTP is allowed outside production)');
    if (!e.CLERK_SECRET_KEY && !e.CLERK_JWT_KEY) problems.push('AUTH_MODE=clerk requires CLERK_SECRET_KEY or CLERK_JWT_KEY');
    const jwtKey = e.CLERK_JWT_KEY?.replace(/\\n/g, '\n');
    if (jwtKey) {
      try {
        if (createPublicKey(jwtKey).asymmetricKeyType !== 'rsa') throw new Error('not RSA');
      } catch { problems.push('CLERK_JWT_KEY must be a PEM RSA public key'); }
    }
    if (e.NODE_ENV === 'production' && e.CLERK_SECRET_KEY?.startsWith('sk_test_')) {
      problems.push('Production requires a Clerk production instance, not CLERK_SECRET_KEY=sk_test_…');
    }
    if (e.NODE_ENV === 'production' && e.CLERK_ISSUER && new URL(e.CLERK_ISSUER).hostname.endsWith('.clerk.accounts.dev')) {
      problems.push('Production requires a Clerk production issuer, not a development instance');
    }
    clerk = { issuer: e.CLERK_ISSUER ?? '', authorizedParties: parties, secretKey: e.CLERK_SECRET_KEY, jwtKey };
  }

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
    clerk,
    sessionSecret: e.SESSION_SECRET,
    publicOrigin: e.PUBLIC_ORIGIN.replace(/\/$/, ''),
    limits: {
      maxUploadBytes: e.MAX_UPLOAD_BYTES,
      maxDefinitionBytes: e.MAX_DEFINITION_BYTES,
      maxStateBytes: e.MAX_STATE_BYTES,
      generationConcurrency: e.GENERATION_CONCURRENCY,
      maxOutputTokens: e.MAX_OUTPUT_TOKENS,
    },
    model: {
      apiKey: e.OPENROUTER_API_KEY,
      baseUrl: e.OPENROUTER_BASE_URL,
      model: e.AUTHORING_MODEL,
      allowed: [...new Set([e.AUTHORING_MODEL, ...list(e.AUTHORING_MODELS)])],
      reasoningEffort: e.AUTHORING_REASONING_EFFORT,
      openAI: { apiKey: e.OPENAI_API_KEY, baseUrl: e.OPENAI_BASE_URL },
    },
    corsOrigins: e.CORS_ORIGINS !== undefined ? list(e.CORS_ORIGINS) : e.NODE_ENV === 'production' ? [] : DEV_CORS_ORIGINS,
    webRoot: e.WEB_ROOT,
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
