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

const capabilityOverrides = z.object({ images: z.boolean().optional(), files: z.boolean().optional(), audio: z.boolean().optional(),
  structuredOutput: z.boolean().optional(), tools: z.boolean().optional(), webSearch: z.literal(false).optional() }).strict();
const compatibleProviders = z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/).refine((id) => !['openrouter', 'openai', 'anthropic', 'gemini', 'fake'].includes(id), 'Provider ID is reserved'),
  baseUrl: z.string().url().refine((url) => ['https:', 'http:'].includes(new URL(url).protocol), 'Use an HTTP(S) endpoint'),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  auth: z.enum(['bearer', 'none']).default('bearer'),
  responseFormat: z.enum(['json_schema', 'json_object', 'prompt']).default('prompt'),
  tokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  capabilities: capabilityOverrides.optional(),
  modelCapabilities: z.record(z.string(), capabilityOverrides).optional(),
}).strict()).refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'Duplicate provider IDs');
type CompatibleProvider = Omit<z.infer<typeof compatibleProviders>[number], 'apiKeyEnv'> & { apiKey: string | undefined };

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: positiveInt.default(8080),
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  /** PEM CA that signs the database server certificate (Aiven project CA); literal \n separators allowed. */
  DATABASE_CA_CERT: z.string().optional(),
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
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  /** Hackathon opt-in: accept a Clerk development instance in production (dev auth stays refused). */
  CLERK_ALLOW_DEVELOPMENT_INSTANCE: bool.default(false),
  MCP_RESOURCE_URL: z.string().url().optional(),
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
  /** Voice-bridge resolver: audio/text utterance + open applet tools → one action. "fake:voice" is free. */
  VOICE_MODEL: z.string().default('google/gemini-3.5-flash-lite'),
  /** Any OpenAI-compatible endpoint, used by "openai:<model>" specs. */
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com/v1'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
  /** JSON endpoint definitions; secrets are referenced by environment variable name. */
  MODEL_PROVIDERS: z.string().optional(),
  OPENAI_RESPONSE_FORMAT: z.enum(['json_schema', 'json_object', 'prompt']).default('json_schema'),
  OPENAI_TOKEN_PARAMETER: z.enum(['max_tokens', 'max_completion_tokens']).default('max_completion_tokens'),
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
  /** PEM CA for verifying the database server certificate, when the system store doesn't cover it. */
  databaseCaCert?: string;
  databasePoolMax: number;
  migrateOnStart: boolean;
  storage: StorageConfig;
  mcp?: { resourceUrl: string; publishableKey: string };
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
    openAI: { apiKey: string | undefined; baseUrl: string; responseFormat?: 'json_schema' | 'json_object' | 'prompt'; tokenParameter?: 'max_tokens' | 'max_completion_tokens' };
    anthropic?: { apiKey: string | undefined; baseUrl: string };
    gemini?: { apiKey: string | undefined; baseUrl: string };
    compatible?: CompatibleProvider[];
  };
  /** Always-listening voice fallback (docs/voice-fallback.md). */
  voice: { model: string };
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
  let compatible: CompatibleProvider[] = [];
  if (e.MODEL_PROVIDERS) {
    try {
      const entries = compatibleProviders.safeParse(JSON.parse(e.MODEL_PROVIDERS));
      if (!entries.success) problems.push('MODEL_PROVIDERS: invalid provider definitions (check IDs, HTTP URLs, auth, output format and capability fields)');
      else compatible = entries.data.map(({ apiKeyEnv, ...provider }) => ({ ...provider, apiKey: apiKeyEnv ? cleaned[apiKeyEnv] : undefined,
        capabilities: { images: false, files: false, audio: false, structuredOutput: provider.responseFormat !== 'prompt', tools: false, ...provider.capabilities } }));
    } catch { problems.push('MODEL_PROVIDERS must be a JSON array of provider definitions'); }
  }
  let mcp: Config['mcp'];
  if (e.MCP_RESOURCE_URL) {
    const url = new URL(e.MCP_RESOURCE_URL);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (e.AUTH_MODE !== 'clerk' || !e.CLERK_SECRET_KEY || !e.CLERK_PUBLISHABLE_KEY) problems.push('MCP_RESOURCE_URL requires Clerk auth, CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY');
    if (url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password ||
        (url.protocol !== 'https:' && !(e.NODE_ENV !== 'production' && local && url.protocol === 'http:'))) {
      problems.push('MCP_RESOURCE_URL must be the exact HTTPS /mcp endpoint (loopback HTTP allowed outside production)');
    }
    mcp = { resourceUrl: e.MCP_RESOURCE_URL, publishableKey: e.CLERK_PUBLISHABLE_KEY ?? '' };
  }
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
    const strictInstance = e.NODE_ENV === 'production' && !e.CLERK_ALLOW_DEVELOPMENT_INSTANCE;
    if (strictInstance && e.CLERK_SECRET_KEY?.startsWith('sk_test_')) {
      problems.push('Production requires a Clerk production instance, not CLERK_SECRET_KEY=sk_test_…');
    }
    if (strictInstance && e.CLERK_ISSUER && new URL(e.CLERK_ISSUER).hostname.endsWith('.clerk.accounts.dev')) {
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

  const databaseCaCert = e.DATABASE_CA_CERT?.replace(/\\n/g, '\n');
  if (databaseCaCert && !databaseCaCert.includes('-----BEGIN CERTIFICATE-----')) {
    problems.push('DATABASE_CA_CERT must be a PEM certificate');
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    migrationDatabaseUrl: e.MIGRATION_DATABASE_URL ?? e.DATABASE_URL,
    databaseCaCert,
    databasePoolMax: e.DATABASE_POOL_MAX,
    migrateOnStart: e.MIGRATE_ON_START,
    storage,
    authMode: e.AUTH_MODE,
    clerk,
    mcp,
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
      openAI: { apiKey: e.OPENAI_API_KEY, baseUrl: e.OPENAI_BASE_URL, responseFormat: e.OPENAI_RESPONSE_FORMAT, tokenParameter: e.OPENAI_TOKEN_PARAMETER },
      anthropic: { apiKey: e.ANTHROPIC_API_KEY, baseUrl: e.ANTHROPIC_BASE_URL },
      gemini: { apiKey: e.GEMINI_API_KEY, baseUrl: e.GEMINI_BASE_URL },
      compatible,
    },
    voice: { model: e.VOICE_MODEL },
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
