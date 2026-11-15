import type { Queryable } from '../pool.ts';

// Per-user model spend (docs/database.md, "model_usage"). Every function takes
// ownerId.

export interface RecordUsageArgs {
  ownerId: string;
  source: string;
  model: string;
  costUsd: number;
  estimated: boolean;
}

export async function recordModelUsage(q: Queryable, a: RecordUsageArgs): Promise<void> {
  await q.query(
    `INSERT INTO model_usage (owner_id, source, model, cost_usd, estimated) VALUES ($1, $2, $3, $4, $5)`,
    [a.ownerId, a.source, a.model, Math.max(0, a.costUsd), a.estimated],
  );
}

/**
 * Spend so far, in USD: the API's direct calls plus every job's recorded
 * `usage.costUsd`. A job that has run without a reported cost, or is still
 * queued/running, counts `estimates[kind]` per attempt (at least one), so
 * nothing in flight is free. Jobs on a `fake:` model never count.
 * `fakeKinds` lists kinds whose configured model is fake (their jobs carry no
 * model in the input).
 */
export async function userSpendUsd(
  q: Queryable,
  ownerId: string,
  estimates: Record<string, number>,
  fakeKinds: string[],
): Promise<number> {
  const { rows } = await q.query<{ spent: string | null }>(
    `SELECT
       COALESCE((SELECT sum(cost_usd) FROM model_usage WHERE owner_id = $1), 0)
       + COALESCE((
           SELECT sum(
             CASE
               WHEN jsonb_typeof(usage -> 'costUsd') = 'number' THEN (usage ->> 'costUsd')::numeric
               WHEN status IN ('queued', 'running') OR attempts > 0
                 THEN COALESCE(($2::jsonb ->> kind)::numeric, 0) * GREATEST(attempts, 1)
               ELSE 0
             END)
             FROM jobs
            WHERE owner_id = $1
              AND $2::jsonb ? kind
              AND NOT (kind = ANY($3::text[]))
              AND COALESCE(input ->> 'model', '') NOT LIKE 'fake:%'
         ), 0) AS spent`,
    [ownerId, JSON.stringify(estimates), fakeKinds],
  );
  return Number(rows[0]?.spent ?? 0);
}
