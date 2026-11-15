import { getUser, recordModelUsage, userSpendUsd } from '@junction26/db';
import type { Deps } from './context.ts';
import { ApiError } from './errors.ts';

/**
 * Per-user demo budget (docs/api.md, "Demo budget"). With USER_BUDGET_USD set,
 * every route that starts paid model work checks the caller's lifetime spend
 * first and answers 402 `budget_exhausted` once it is used up. `fake:` models
 * are always free and never blocked.
 *
 * Spend = API-side calls recorded in model_usage + job usage. A call or job
 * that reports no cost counts a conservative estimate, so a provider that
 * omits costs can't make usage free. Concurrent requests can overshoot the
 * cap by at most what is already in flight (each in-flight job is reserved at
 * its estimate).
 */

/** Conservative USD per attempt when a provider reports no cost. */
export const JOB_ESTIMATES: Record<string, number> = {
  generate_revision: 0.03,
  coach_request: 0.005,
  extract_care_label: 0.005,
  transcribe_voice_note: 0.01,
};
export const CALL_ESTIMATE_USD = 0.002;

export const isFake = (spec: string) => spec.startsWith('fake:');

function fakeKinds(deps: Deps): string[] {
  const c = deps.config;
  const kinds: string[] = [];
  if (isFake(c.coach.model)) kinds.push('coach_request');
  if (isFake(c.laundry.labelModel)) kinds.push('extract_care_label');
  if (isFake(c.notes.transcribeModel)) kinds.push('transcribe_voice_note');
  return kinds;
}

export interface BudgetStatus {
  /** null when no cap applies to this user. */
  budgetUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  exempt: boolean;
}

async function isExempt(deps: Deps, userId: string): Promise<boolean> {
  const list = deps.config.budget.exempt;
  if (!list.length) return false;
  if (list.includes(userId)) return true;
  const user = await getUser(deps.pool, userId);
  return !!user && list.includes(user.externalId);
}

export async function budgetStatus(deps: Deps, userId: string): Promise<BudgetStatus> {
  const spentUsd = round(await userSpendUsd(deps.pool, userId, JOB_ESTIMATES, fakeKinds(deps)));
  const cap = deps.config.budget.userUsd;
  const exempt = cap !== null && (await isExempt(deps, userId));
  if (cap === null || exempt) return { budgetUsd: null, spentUsd, remainingUsd: null, exempt };
  return { budgetUsd: cap, spentUsd, remainingUsd: round(Math.max(0, cap - spentUsd)), exempt };
}

/** Throws 402 when `userId` may not start paid work on `spec`. */
export async function assertBudget(deps: Deps, userId: string, spec: string): Promise<void> {
  if (deps.config.budget.userUsd === null || isFake(spec)) return;
  const s = await budgetStatus(deps, userId);
  if (s.remainingUsd !== null && s.remainingUsd <= 0) {
    throw new ApiError(402, 'budget_exhausted', `Your demo budget of $${s.budgetUsd!.toFixed(2)} is used up`, {
      budgetUsd: s.budgetUsd,
      spentUsd: s.spentUsd,
    });
  }
}

/** Records an API-side model call. Never throws: a ledger failure must not fail the answer. */
export async function recordSpend(deps: Deps, userId: string, source: string, model: string, costUsd: number | null): Promise<void> {
  if (isFake(model)) return;
  await recordModelUsage(deps.pool, {
    ownerId: userId,
    source,
    model,
    costUsd: costUsd ?? CALL_ESTIMATE_USD,
    estimated: costUsd === null,
  }).catch((err: unknown) => deps.logger.warn('model usage not recorded', { source, err }));
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
