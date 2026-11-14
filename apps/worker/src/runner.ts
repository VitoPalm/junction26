import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  claimJob,
  completeJob,
  failExhaustedJobs,
  failJob,
  heartbeatJob,
  markJobCancelled,
  releaseWorkerLeases,
  type Job,
  type JobErrorInfo,
  type JobKind,
} from '@junction26/db';
import { JobError, type HandlerRegistry, type WorkerDeps } from './types.ts';

type AbortReason = 'cancelled' | 'lease_lost' | 'shutdown';

export interface RunnerOptions {
  workerId?: string;
  concurrency: number;
  /** Max concurrent `generate_revision` jobs in this worker (model spend). */
  generationConcurrency: number;
  pollMs: number;
  leaseMs: number;
  /** Backoff before retry attempt n (1-based). */
  retryDelayMs?: (attempt: number) => number;
}

const defaultBackoff = (attempt: number) => Math.min(60_000, 2_000 * 2 ** (attempt - 1));

/**
 * Polls PostgreSQL for jobs and runs them with a lease and heartbeat.
 * Lifecycle and guarantees are documented in docs/jobs.md.
 */
export class JobRunner {
  readonly workerId: string;
  private readonly deps: WorkerDeps;
  private readonly handlers: HandlerRegistry;
  private readonly options: Required<RunnerOptions>;
  private readonly active = new Map<string, { job: Job; controller: AbortController; done: Promise<void> }>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private ticking = false;
  private ticks = 0;
  lastTickAt = 0;

  constructor(deps: WorkerDeps, handlers: HandlerRegistry, options: RunnerOptions) {
    this.deps = deps;
    this.handlers = handlers;
    this.workerId = options.workerId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
    this.options = { retryDelayMs: defaultBackoff, ...options, workerId: this.workerId };
  }

  get activeCount(): number {
    return this.active.size;
  }

  start(): void {
    this.deps.logger.info('worker started', { workerId: this.workerId, kinds: Object.keys(this.handlers), concurrency: this.options.concurrency });
    const loop = async () => {
      await this.tick().catch((err: unknown) => this.deps.logger.error('poll failed', { err }));
      if (!this.stopping) this.timer = setTimeout(loop, this.options.pollMs * (0.75 + Math.random() * 0.5));
    };
    void loop();
  }

  /** One poll: sweep exhausted leases, then claim until full or the queue is empty. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      this.lastTickAt = Date.now();
      if (this.ticks++ % 10 === 0) {
        const failed = await failExhaustedJobs(this.deps.pool);
        if (failed) this.deps.logger.warn('failed jobs whose final attempt lost its worker', { count: failed });
      }
      while (!this.stopping && this.active.size < this.options.concurrency) {
        const kinds = this.claimableKinds();
        if (!kinds.length) break;
        const job = await claimJob(this.deps.pool, this.workerId, this.options.leaseMs, kinds);
        if (!job) break;
        this.launch(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  private claimableKinds(): JobKind[] {
    const generating = [...this.active.values()].filter((a) => a.job.kind === 'generate_revision').length;
    return (Object.keys(this.handlers) as JobKind[]).filter(
      (k) => k !== 'generate_revision' || generating < this.options.generationConcurrency,
    );
  }

  private launch(job: Job): void {
    const controller = new AbortController();
    const done = this.execute(job, controller).finally(() => this.active.delete(job.id));
    this.active.set(job.id, { job, controller, done });
  }

  private async execute(job: Job, controller: AbortController): Promise<void> {
    const { pool } = this.deps;
    const log = this.deps.logger.child({ jobId: job.id, kind: job.kind, attempt: job.attempts, projectId: job.projectId });
    const handler = this.handlers[job.kind]!;
    const started = performance.now();
    log.info('job started');

    const beat = async (progress?: unknown) => {
      const hb = await heartbeatJob(pool, job.id, this.workerId, this.options.leaseMs, progress);
      if (!hb.held) controller.abort('lease_lost' satisfies AbortReason);
      else if (hb.cancelRequested) controller.abort('cancelled' satisfies AbortReason);
    };
    const heartbeat = setInterval(() => {
      beat().catch((err: unknown) => log.warn('heartbeat failed', { err }));
    }, Math.max(250, Math.floor(this.options.leaseMs / 3)));
    if (job.cancelRequested) controller.abort('cancelled' satisfies AbortReason);

    try {
      const outcome = await handler.run(job, { deps: this.deps, log, signal: controller.signal, progress: beat });
      if (controller.signal.aborted) throw controller.signal.reason;
      const saved = await completeJob(pool, job.id, this.workerId, outcome.result, outcome.usage);
      log.info(saved ? 'job succeeded' : 'job finished after losing its lease; result discarded', {
        ms: Math.round(performance.now() - started),
      });
    } catch (err) {
      const reason = controller.signal.aborted ? (controller.signal.reason as AbortReason) : null;
      if (reason === 'cancelled') {
        await markJobCancelled(pool, job.id, this.workerId);
        log.info('job cancelled');
      } else if (reason === 'lease_lost') {
        log.warn('job lease lost; another worker owns it now');
      } else if (reason === 'shutdown') {
        log.info('job interrupted by shutdown; lease released');
      } else {
        await this.recordFailure(job, err, log);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async recordFailure(job: Job, err: unknown, log: WorkerDeps['logger']): Promise<void> {
    const info: JobErrorInfo =
      err instanceof JobError
        ? { code: err.code, message: err.message, retryable: err.retryable, ...(err.details !== undefined ? { details: err.details } : {}) }
        : { code: 'internal', message: 'The job failed unexpectedly', retryable: true };
    const retryAfter = info.retryable ? this.options.retryDelayMs(job.attempts) : null;
    const state = await failJob(this.deps.pool, job.id, this.workerId, info, retryAfter);
    log[state === 'retrying' ? 'warn' : 'error']('job attempt failed', { code: info.code, state, err });
    if (state === 'failed' && this.handlers[job.kind]?.onFailed) {
      await this.handlers[job.kind]!.onFailed!(job, info, this.deps).catch((e: unknown) => log.error('onFailed hook failed', { err: e }));
    }
  }

  /**
   * Stops claiming, gives running jobs `graceMs` to finish, then aborts the
   * rest and hands their leases back so another worker resumes them at once.
   */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const running = [...this.active.values()];
    const all = Promise.allSettled(running.map((a) => a.done));
    const timedOut = await Promise.race([all.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), graceMs).unref())]);
    if (timedOut) {
      for (const a of this.active.values()) a.controller.abort('shutdown' satisfies AbortReason);
      await Promise.race([Promise.allSettled([...this.active.values()].map((a) => a.done)), new Promise((r) => setTimeout(r, 2000).unref())]);
    }
    const released = await releaseWorkerLeases(this.deps.pool, this.workerId);
    this.deps.logger.info('worker stopped', { workerId: this.workerId, releasedLeases: released });
  }
}
