import type { Queryable } from '../pool.ts';
import { camel, type Job, type JobErrorInfo, type JobKind } from '../rows.ts';

/**
 * Durable job queue on PostgreSQL.
 *
 * - Claims use `FOR UPDATE SKIP LOCKED`, so concurrent workers never take the
 *   same row.
 * - A claim sets a lease (`lease_owner`, `lease_expires_at`). Workers extend it
 *   with heartbeats. A job whose lease expired is claimable again (recovery
 *   after a crash), until `attempts` reaches `max_attempts`.
 * - Every state change after a claim is fenced on `lease_owner`: a worker that
 *   lost its lease can't overwrite the new owner's result.
 */

export interface EnqueueArgs {
  ownerId: string;
  projectId: string | null;
  kind: JobKind;
  input: Record<string, unknown>;
  idempotencyKey?: string | null;
  maxAttempts?: number;
}

/**
 * Inserts a job, or returns the existing one for the same (owner, idempotency
 * key). `created` tells the caller which happened.
 */
export async function enqueueJob(q: Queryable, args: EnqueueArgs): Promise<{ job: Job; created: boolean }> {
  const { rows } = await q.query(
    `INSERT INTO jobs (owner_id, project_id, kind, input, idempotency_key, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [args.ownerId, args.projectId, args.kind, JSON.stringify(args.input), args.idempotencyKey ?? null, args.maxAttempts ?? 3],
  );
  if (rows[0]) return { job: camel<Job>(rows[0]), created: true };
  const existing = await findJobByIdempotencyKey(q, args.ownerId, args.idempotencyKey!);
  if (!existing) throw new Error('Idempotent job insert conflicted but no existing job was found');
  return { job: existing, created: false };
}

export async function findJobByIdempotencyKey(q: Queryable, ownerId: string, key: string): Promise<Job | null> {
  const { rows } = await q.query('SELECT * FROM jobs WHERE owner_id = $1 AND idempotency_key = $2', [ownerId, key]);
  return rows[0] ? camel<Job>(rows[0]) : null;
}

export async function getJobForOwner(q: Queryable, ownerId: string, id: string): Promise<Job | null> {
  const { rows } = await q.query('SELECT * FROM jobs WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rows[0] ? camel<Job>(rows[0]) : null;
}

export async function getJobById(q: Queryable, id: string): Promise<Job | null> {
  const { rows } = await q.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0] ? camel<Job>(rows[0]) : null;
}

/**
 * Best-effort cancellation: a queued job is cancelled now; a running job is
 * flagged and its worker stops at the next heartbeat. Finished jobs are left
 * unchanged. Returns the job after the change.
 */
export async function requestJobCancel(q: Queryable, ownerId: string, id: string): Promise<Job | null> {
  const { rows } = await q.query(
    `UPDATE jobs
        SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
            finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END,
            cancel_requested = CASE WHEN status IN ('queued', 'running') THEN true ELSE cancel_requested END,
            updated_at = now()
      WHERE id = $1 AND owner_id = $2
      RETURNING *`,
    [id, ownerId],
  );
  return rows[0] ? camel<Job>(rows[0]) : null;
}

/** Fails running jobs whose lease expired after their last allowed attempt. */
export async function failExhaustedJobs(q: Queryable): Promise<number> {
  const { rowCount } = await q.query(
    `UPDATE jobs
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now(),
            error = jsonb_build_object('code', 'lease_expired',
                                       'message', 'The worker stopped responding on the final attempt')
      WHERE status = 'running' AND lease_expires_at < now() AND attempts >= max_attempts`,
  );
  return rowCount ?? 0;
}

/**
 * Claims the oldest runnable job: a queued job whose `run_after` has passed, or
 * a running job whose lease expired (its worker died) with attempts left.
 */
export async function claimJob(q: Queryable, workerId: string, leaseMs: number, kinds: JobKind[]): Promise<Job | null> {
  const { rows } = await q.query(
    `UPDATE jobs
        SET status = 'running', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2::double precision / 1000),
            attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM jobs
         WHERE kind = ANY($3::text[])
           AND ((status = 'queued' AND run_after <= now())
             OR (status = 'running' AND lease_expires_at < now() AND attempts < max_attempts))
         ORDER BY run_after, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [workerId, leaseMs, kinds],
  );
  return rows[0] ? camel<Job>(rows[0]) : null;
}

export interface HeartbeatResult {
  /** False when this worker no longer holds the lease; stop work immediately. */
  held: boolean;
  cancelRequested: boolean;
}

export async function heartbeatJob(q: Queryable, id: string, workerId: string, leaseMs: number, progress?: unknown): Promise<HeartbeatResult> {
  const { rows } = await q.query(
    `UPDATE jobs
        SET lease_expires_at = now() + make_interval(secs => $3::double precision / 1000),
            progress = COALESCE($4::jsonb, progress), updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'
      RETURNING cancel_requested`,
    [id, workerId, leaseMs, progress === undefined ? null : JSON.stringify(progress)],
  );
  return rows[0] ? { held: true, cancelRequested: rows[0].cancel_requested as boolean } : { held: false, cancelRequested: false };
}

/** Returns false when the lease was lost (the result is discarded). */
export async function completeJob(q: Queryable, id: string, workerId: string, result: unknown, usage?: unknown): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE jobs
        SET status = 'succeeded', result = $3, usage = COALESCE($4::jsonb, usage), error = NULL,
            lease_owner = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [id, workerId, JSON.stringify(result ?? null), usage === undefined ? null : JSON.stringify(usage)],
  );
  return rowCount === 1;
}

/**
 * Records a failed attempt. With `retryAfterMs` and attempts left the job goes
 * back to `queued`; otherwise it fails permanently.
 */
export async function failJob(
  q: Queryable,
  id: string,
  workerId: string,
  error: JobErrorInfo,
  retryAfterMs: number | null,
  usage?: unknown,
): Promise<'retrying' | 'failed' | 'lost'> {
  const { rows } = await q.query(
    `UPDATE jobs
        SET status = CASE WHEN $4::double precision IS NOT NULL AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
            run_after = CASE WHEN $4::double precision IS NOT NULL AND attempts < max_attempts
                             THEN now() + make_interval(secs => $4::double precision / 1000) ELSE run_after END,
            finished_at = CASE WHEN $4::double precision IS NOT NULL AND attempts < max_attempts THEN NULL ELSE now() END,
            error = $3, usage = COALESCE($5::jsonb, usage),
            lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'
      RETURNING status`,
    [id, workerId, JSON.stringify(error), retryAfterMs, usage === undefined ? null : JSON.stringify(usage)],
  );
  if (!rows[0]) return 'lost';
  return rows[0].status === 'queued' ? 'retrying' : 'failed';
}

export async function markJobCancelled(q: Queryable, id: string, workerId: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [id, workerId],
  );
  return rowCount === 1;
}

/**
 * Graceful shutdown: hands this worker's running jobs back to the queue. The
 * interrupted attempt isn't counted against the job.
 */
export async function releaseWorkerLeases(q: Queryable, workerId: string): Promise<number> {
  const { rowCount } = await q.query(
    `UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
                     attempts = GREATEST(attempts - 1, 0), updated_at = now()
      WHERE lease_owner = $1 AND status = 'running'`,
    [workerId],
  );
  return rowCount ?? 0;
}
