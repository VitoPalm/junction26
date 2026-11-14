import type { Pool } from '../pool.ts';
import { withTransaction } from '../pool.ts';
import { camel, type StateBackup } from '../rows.ts';

export interface PutStateArgs {
  projectId: string;
  deviceId: string;
  operationId: string;
  sequence: number;
  revisionId: string | null;
  schemaVersion: number;
  /** The server version the device last saw (0 = no backup yet). */
  expectedServerVersion: number;
  snapshot: unknown;
}

export interface CurrentState {
  serverVersion: number;
  deviceId: string;
  sequence: number;
  backup: StateBackup;
}

export type PutStateResult =
  | { outcome: 'accepted'; serverVersion: number; backupId: string; replayed: boolean }
  | { outcome: 'conflict' | 'stale'; current: Omit<CurrentState, 'backup'> | null; backupId: string; replayed: boolean };

/**
 * Stores a state backup from a glasses device (see docs/backend-architecture.md,
 * "State synchronization"):
 *
 * - Replaying an `operationId` returns the original outcome without changes.
 * - `expectedServerVersion` must equal the current server version, else
 *   `conflict`. Both snapshots are kept; nothing is merged or overwritten.
 * - From the same device, a sequence not greater than the current one is
 *   `stale` (an older write arriving late).
 * - Otherwise the backup is accepted and the server version increments.
 */
export async function putStateBackup(pool: Pool, args: PutStateArgs): Promise<PutStateResult> {
  return withTransaction(pool, async (c) => {
    // Lock the project row: serializes writers even before project_state exists.
    await c.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [args.projectId]);

    const prior = await c.query(
      'SELECT * FROM state_backups WHERE project_id = $1 AND device_id = $2 AND operation_id = $3',
      [args.projectId, args.deviceId, args.operationId],
    );
    const current = await readCurrent(c, args.projectId);
    const currentSummary = current && { serverVersion: current.serverVersion, deviceId: current.deviceId, sequence: current.sequence };

    if (prior.rows[0]) {
      const b = camel<StateBackup>(prior.rows[0]);
      return b.outcome === 'accepted'
        ? { outcome: 'accepted', serverVersion: b.serverVersion!, backupId: b.id, replayed: true }
        : { outcome: b.outcome, current: currentSummary, backupId: b.id, replayed: true };
    }

    const currentVersion = current?.serverVersion ?? 0;
    let outcome: StateBackup['outcome'] = 'accepted';
    if (args.expectedServerVersion !== currentVersion) outcome = 'conflict';
    else if (current && current.deviceId === args.deviceId && args.sequence <= current.sequence) outcome = 'stale';

    const serverVersion = outcome === 'accepted' ? currentVersion + 1 : null;
    const { rows } = await c.query(
      `INSERT INTO state_backups (project_id, device_id, operation_id, sequence, revision_id, schema_version,
                                  expected_server_version, snapshot, outcome, server_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        args.projectId,
        args.deviceId,
        args.operationId,
        args.sequence,
        args.revisionId,
        args.schemaVersion,
        args.expectedServerVersion,
        JSON.stringify(args.snapshot),
        outcome,
        serverVersion,
      ],
    );
    const backupId = rows[0]!.id as string;

    if (outcome !== 'accepted') return { outcome, current: currentSummary, backupId, replayed: false };

    await c.query(
      `INSERT INTO project_state (project_id, server_version, backup_id, device_id, sequence)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id) DO UPDATE
         SET server_version = EXCLUDED.server_version, backup_id = EXCLUDED.backup_id,
             device_id = EXCLUDED.device_id, sequence = EXCLUDED.sequence, updated_at = now()`,
      [args.projectId, serverVersion, backupId, args.deviceId, args.sequence],
    );
    return { outcome: 'accepted', serverVersion: serverVersion!, backupId, replayed: false };
  });
}

async function readCurrent(q: Pick<Pool, 'query'>, projectId: string): Promise<CurrentState | null> {
  const { rows } = await q.query(
    `SELECT ps.server_version AS ps_version, ps.device_id AS ps_device, ps.sequence AS ps_sequence, b.*
       FROM project_state ps JOIN state_backups b ON b.id = ps.backup_id
      WHERE ps.project_id = $1`,
    [projectId],
  );
  if (!rows[0]) return null;
  const { ps_version, ps_device, ps_sequence, ...backup } = rows[0];
  return {
    serverVersion: ps_version as number,
    deviceId: ps_device as string,
    sequence: ps_sequence as number,
    backup: camel<StateBackup>(backup),
  };
}

/** The last accepted backup, for recovery. */
export async function getCurrentState(q: Pick<Pool, 'query'>, projectId: string): Promise<CurrentState | null> {
  return readCurrent(q, projectId);
}
