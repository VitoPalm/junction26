import type { Queryable } from '../pool.ts';
import { camel, camelRows, type Device } from '../rows.ts';

const DEVICE_COLUMNS = 'id, owner_id, label, created_at, last_seen_at, revoked_at';

export async function createPairingCode(q: Queryable, ownerId: string, codeHash: string, expiresAt: Date): Promise<void> {
  await q.query('INSERT INTO pairing_codes (code_hash, owner_id, expires_at) VALUES ($1, $2, $3)', [codeHash, ownerId, expiresAt]);
}

/** Atomically marks an unexpired, unused code as used; returns its owner or null. */
export async function consumePairingCode(q: Queryable, codeHash: string): Promise<string | null> {
  const { rows } = await q.query(
    `UPDATE pairing_codes SET used_at = now()
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING owner_id`,
    [codeHash],
  );
  return (rows[0]?.owner_id as string | undefined) ?? null;
}

export async function createDevice(q: Queryable, ownerId: string, label: string, tokenHash: string): Promise<Device> {
  const { rows } = await q.query(
    `INSERT INTO devices (owner_id, label, token_hash) VALUES ($1, $2, $3) RETURNING ${DEVICE_COLUMNS}`,
    [ownerId, label, tokenHash],
  );
  return camel<Device>(rows[0]!);
}

/** Finds an unrevoked device session and records that it was seen. */
export async function authenticateDevice(q: Queryable, tokenHash: string): Promise<Device | null> {
  const { rows } = await q.query(
    `UPDATE devices SET last_seen_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING ${DEVICE_COLUMNS}`,
    [tokenHash],
  );
  return rows[0] ? camel<Device>(rows[0]) : null;
}

export async function listDevices(q: Queryable, ownerId: string): Promise<Device[]> {
  const { rows } = await q.query(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE owner_id = $1 ORDER BY created_at DESC`, [ownerId]);
  return camelRows<Device>(rows);
}

export async function revokeDevice(q: Queryable, ownerId: string, id: string): Promise<Device | null> {
  const { rows } = await q.query(
    `UPDATE devices SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND owner_id = $2 RETURNING ${DEVICE_COLUMNS}`,
    [id, ownerId],
  );
  return rows[0] ? camel<Device>(rows[0]) : null;
}
