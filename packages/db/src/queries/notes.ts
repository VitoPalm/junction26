import type { Queryable } from '../pool.ts';
import { camel, camelRows, type JobErrorInfo, type VoiceNote, type VoiceNoteEndReason } from '../rows.ts';

// Voice notes (docs/voice-notes.md, docs/database.md). Every function that
// reads or changes a user's note takes ownerId, except the worker-only ones
// marked "internal".

export interface CreateVoiceNoteArgs {
  id: string;
  ownerId: string;
  projectId: string;
  releaseId: string | null;
  deviceId: string | null;
  viewId: string;
  stepId: string | null;
  pageLabel: string;
  noteLabel: string | null;
  stateSnapshot: unknown;
}

/**
 * Idempotent on `id`: a retried start returns the existing note. Returns null
 * when the id already belongs to someone else (never reveal it).
 */
export async function createVoiceNote(q: Queryable, a: CreateVoiceNoteArgs): Promise<{ note: VoiceNote; created: boolean } | null> {
  const { rows } = await q.query(
    `INSERT INTO voice_notes (id, owner_id, project_id, release_id, device_id, view_id, step_id, page_label, note_label, state_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [a.id, a.ownerId, a.projectId, a.releaseId, a.deviceId, a.viewId, a.stepId, a.pageLabel, a.noteLabel, a.stateSnapshot === undefined ? null : JSON.stringify(a.stateSnapshot)],
  );
  if (rows[0]) return { note: camel<VoiceNote>(rows[0]), created: true };
  const existing = await getVoiceNote(q, a.ownerId, a.id);
  return existing ? { note: existing, created: false } : null;
}

export async function getVoiceNote(q: Queryable, ownerId: string, id: string): Promise<VoiceNote | null> {
  const { rows } = await q.query('SELECT * FROM voice_notes WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rows[0] ? camel<VoiceNote>(rows[0]) : null;
}

/** Internal (worker): no owner filter. */
export async function getVoiceNoteById(q: Queryable, id: string): Promise<VoiceNote | null> {
  const { rows } = await q.query('SELECT * FROM voice_notes WHERE id = $1', [id]);
  return rows[0] ? camel<VoiceNote>(rows[0]) : null;
}

/** Notes the phone app shows: everything with audio, plus notes being recorded right now. */
export async function listVoiceNotes(q: Queryable, ownerId: string, projectId: string): Promise<VoiceNote[]> {
  const { rows } = await q.query(
    `SELECT * FROM voice_notes
      WHERE owner_id = $1 AND project_id = $2 AND status NOT IN ('starting', 'discarded')
      ORDER BY started_at DESC
      LIMIT 500`,
    [ownerId, projectId],
  );
  return camelRows<VoiceNote>(rows);
}

/** Saved notes per page, for the glasses' "N on phone" hint. */
export async function countVoiceNotes(q: Queryable, ownerId: string, projectId: string): Promise<{ viewId: string; stepId: string | null; count: number }[]> {
  const { rows } = await q.query(
    `SELECT view_id, step_id, count(*)::int AS count FROM voice_notes
      WHERE owner_id = $1 AND project_id = $2 AND audio_key IS NOT NULL
      GROUP BY view_id, step_id`,
    [ownerId, projectId],
  );
  return camelRows(rows);
}

/** The phone confirmed it is recording. Only moves starting → recording. */
export async function markVoiceNoteRecording(q: Queryable, ownerId: string, id: string): Promise<VoiceNote | null> {
  const { rows } = await q.query(
    `UPDATE voice_notes SET status = CASE WHEN status = 'starting' THEN 'recording' ELSE status END, updated_at = now()
      WHERE id = $1 AND owner_id = $2 RETURNING *`,
    [id, ownerId],
  );
  return rows[0] ? camel<VoiceNote>(rows[0]) : null;
}

export interface StoreAudioArgs {
  key: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  durationMs: number | null;
  endReason: VoiceNoteEndReason | null;
}

/**
 * Records stored audio and resets the transcript status. A re-upload of the
 * same bytes (same hash) is a replay and changes nothing.
 */
export async function storeVoiceNoteAudio(q: Queryable, ownerId: string, id: string, a: StoreAudioArgs): Promise<{ note: VoiceNote; replayed: boolean } | null> {
  const current = await q.query('SELECT * FROM voice_notes WHERE id = $1 AND owner_id = $2 FOR UPDATE', [id, ownerId]);
  if (!current.rows[0]) return null;
  const note = camel<VoiceNote>(current.rows[0]);
  if (note.audioSha256 === a.sha256) return { note, replayed: true };
  const { rows } = await q.query(
    `UPDATE voice_notes
        SET audio_key = $3, audio_media_type = $4, audio_sha256 = $5, audio_bytes = $6,
            duration_ms = COALESCE($7, duration_ms), end_reason = COALESCE($8, end_reason),
            ended_at = COALESCE(ended_at, now()), status = 'uploaded', error = NULL, updated_at = now()
      WHERE id = $1 AND owner_id = $2 RETURNING *`,
    [id, ownerId, a.key, a.mediaType, a.sha256, a.bytes, a.durationMs, a.endReason],
  );
  return { note: camel<VoiceNote>(rows[0]!), replayed: false };
}

/** Nothing worth keeping (too short, cancelled). Notes with audio are never discarded this way. */
export async function discardVoiceNote(q: Queryable, ownerId: string, id: string, reason: VoiceNoteEndReason | null): Promise<VoiceNote | null> {
  const { rows } = await q.query(
    `UPDATE voice_notes SET status = 'discarded', end_reason = COALESCE($3, end_reason), ended_at = COALESCE(ended_at, now()), updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND audio_key IS NULL RETURNING *`,
    [id, ownerId, reason],
  );
  return rows[0] ? camel<VoiceNote>(rows[0]) : getVoiceNote(q, ownerId, id);
}

/** The wearer edited the transcript on the phone; later transcriptions won't overwrite it. */
export async function editVoiceNoteTranscript(q: Queryable, ownerId: string, id: string, transcript: string): Promise<VoiceNote | null> {
  const { rows } = await q.query(
    `UPDATE voice_notes SET transcript = $3, transcript_edited = true, updated_at = now()
      WHERE id = $1 AND owner_id = $2 RETURNING *`,
    [id, ownerId, transcript],
  );
  return rows[0] ? camel<VoiceNote>(rows[0]) : null;
}

/** Deletes the row; returns the audio key so the caller can remove the object. */
export async function deleteVoiceNote(q: Queryable, ownerId: string, id: string): Promise<{ audioKey: string | null } | null> {
  const { rows } = await q.query('DELETE FROM voice_notes WHERE id = $1 AND owner_id = $2 RETURNING audio_key', [id, ownerId]);
  return rows[0] ? { audioKey: (rows[0].audio_key as string | null) ?? null } : null;
}

/** Internal (worker). Only for the audio the job was queued for. */
export async function markVoiceNoteTranscribing(q: Queryable, id: string, sha256: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE voice_notes SET status = 'transcribing', updated_at = now()
      WHERE id = $1 AND audio_sha256 = $2 AND status IN ('uploaded', 'failed', 'transcribing')`,
    [id, sha256],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Internal (worker). Saves the transcript only if the audio hasn't changed
 * since, and never overwrites a transcript the wearer edited.
 */
export async function finishVoiceNoteTranscript(q: Queryable, id: string, sha256: string, transcript: string, model: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE voice_notes
        SET transcript = CASE WHEN transcript_edited THEN transcript ELSE $3 END,
            transcript_model = $4, transcribed_sha256 = $2, status = 'transcribed', error = NULL, updated_at = now()
      WHERE id = $1 AND audio_sha256 = $2`,
    [id, sha256, transcript, model],
  );
  return (rowCount ?? 0) > 0;
}

/** Internal (worker). The audio stays; the phone shows "couldn't transcribe". */
export async function failVoiceNoteTranscript(q: Queryable, id: string, sha256: string | null, error: JobErrorInfo): Promise<void> {
  await q.query(
    `UPDATE voice_notes SET status = 'failed', error = $3, updated_at = now()
      WHERE id = $1 AND ($2::text IS NULL OR audio_sha256 = $2) AND status IN ('uploaded', 'transcribing')`,
    [id, sha256, JSON.stringify(error)],
  );
}
