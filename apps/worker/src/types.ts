import type { Config, Logger } from '@junction26/server-common';
import type { Job, JobErrorInfo, JobKind, Pool } from '@junction26/db';
import type { ObjectStore } from '@junction26/storage';

export interface WorkerDeps {
  config: Config;
  pool: Pool;
  store: ObjectStore;
  logger: Logger;
}

export interface JobContext {
  deps: WorkerDeps;
  log: Logger;
  /**
   * Aborted when the job is cancelled, the lease is lost, or the worker shuts
   * down. Long steps must pass it on (fetch, storage) or check it between steps.
   */
  signal: AbortSignal;
  /** Saves progress visible at GET /v1/jobs/:id (also extends the lease). */
  progress(value: unknown): Promise<void>;
}

export interface JobOutcome {
  result: unknown;
  usage?: unknown;
}

export interface JobHandler {
  run(job: Job, ctx: JobContext): Promise<JobOutcome>;
  /** Called once when the job fails permanently (to release reserved resources, mark records). */
  onFailed?(job: Job, error: JobErrorInfo, deps: WorkerDeps): Promise<void>;
}

export type HandlerRegistry = Partial<Record<JobKind, JobHandler>>;

/**
 * A failure with a stable code. `retryable` failures go back to the queue with
 * backoff until `max_attempts`; others fail the job immediately. Unexpected
 * exceptions are treated as retryable (transient until proven otherwise).
 */
export class JobError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;
  constructor(code: string, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
