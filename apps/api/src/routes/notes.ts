import { randomBytes } from 'node:crypto';
import { hmac } from '../auth.ts';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  countVoiceNotes,
  createVoiceNote,
  deleteVoiceNote,
  discardVoiceNote,
  editVoiceNoteTranscript,
  enqueueJob,
  getProject,
  getVoiceNote,
  listVoiceNotes,
  markVoiceNoteRecording,
  storeVoiceNoteAudio,
  withTransaction,
  type VoiceNote,
  type VoiceNoteEndReason,
} from '@junction26/db';
import { ModelError, type ModelRegistry } from '@junction26/model';
import { objectKeys } from '@junction26/storage';
import { assertBudget, recordSpend } from '../budget.ts';
import type { AppEnv, Deps, Principal } from '../context.ts';
import { requireDevice, requireUser } from '../auth.ts';
import { ApiError, badRequest, forbidden, notFound } from '../errors.ts';
import { readJson, uuid } from '../http.ts';
import { checkStopPhrase, sniffMp3, sniffWav, type NoteEvent, type NoteHub, type RecorderEvent } from '../notes.ts';
import { Inspector, UploadRejected } from './uploads.ts';

/** About 12 s of 16 kHz mono PCM16. Windows only need the last few seconds. */
export const MAX_LIVE_WINDOW_BYTES = 384 * 1024;
const LIVE_DEADLINE_MS = 6_000;
const HEARTBEAT_MS = 25_000;

const id = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const StartBody = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  releaseId: z.uuid().nullable().optional(),
  viewId: id,
  stepId: id.nullable().optional(),
  pageLabel: z.string().trim().min(1).max(120),
  noteLabel: z.string().trim().min(1).max(60).nullable().optional(),
  /** describeState() at start; shown on the phone as context. */
  stateSnapshot: z.record(z.string(), z.unknown()).optional(),
});
const StopBody = z.object({ reason: z.enum(['band', 'voice', 'timeout']).default('band') });
const DiscardBody = z.object({ reason: z.enum(['too_short', 'interrupted', 'disconnect', 'phone']).default('too_short') });
const EditBody = z.object({ transcript: z.string().max(20_000) });
const END_REASONS = new Set<VoiceNoteEndReason>(['phrase', 'band', 'voice', 'timeout', 'disconnect', 'interrupted', 'phone']);

const AUDIO_TYPES: Record<string, (head: Buffer) => boolean> = {
  'audio/wav': sniffWav,
  'audio/x-wav': sniffWav,
  'audio/wave': sniffWav,
  'audio/mpeg': sniffMp3,
};

/** Public JSON shape. Object keys never leave the server. */
export const noteView = (n: VoiceNote) => ({
  id: n.id,
  projectId: n.projectId,
  releaseId: n.releaseId,
  viewId: n.viewId,
  stepId: n.stepId,
  pageLabel: n.pageLabel,
  noteLabel: n.noteLabel,
  stateSnapshot: n.stateSnapshot,
  status: n.status,
  endReason: n.endReason,
  startedAt: n.startedAt,
  endedAt: n.endedAt,
  durationMs: n.durationMs,
  audio: n.audioKey ? { url: `/v1/notes/${n.id}/audio`, mediaType: n.audioMediaType, bytes: n.audioBytes, sha256: n.audioSha256 } : null,
  transcript: n.transcript,
  transcriptEdited: n.transcriptEdited,
  transcriptModel: n.transcriptModel,
  language: n.language,
  error: n.error ? { code: n.error.code, message: n.error.message } : null,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
});

/** Glasses (device) or phone (user) sessions; delegated assistants never. */
function userOrDevice(p: Principal): asserts p is Extract<Principal, { kind: 'user' | 'device' }> {
  if (p.kind !== 'user' && p.kind !== 'device') throw forbidden('Voice notes need a user or paired device session');
}

async function ownNote(deps: Deps, c: Context<AppEnv>): Promise<VoiceNote> {
  const noteId = c.req.param('noteId');
  if (!noteId || !uuid.safeParse(noteId).success) throw notFound('Note');
  const note = await getVoiceNote(deps.pool, c.get('principal').userId, noteId);
  if (!note) throw notFound('Note');
  return note;
}

/** Writes SSE events from an in-process subscription until the client goes away or `done` says so. */
function sse<E extends { type: string }>(c: Context<AppEnv>, subscribe: (push: (e: E) => void) => () => void, first: E[] = [], done: (e: E) => boolean = () => false, authorized: () => Promise<boolean> = async () => true) {
  return streamSSE(c, async (stream) => {
    const queue: E[] = [...first];
    let wake: (() => void) | null = null;
    const unsubscribe = subscribe((e) => {
      queue.push(e);
      wake?.();
    });
    let open = true;
    stream.onAbort(() => {
      open = false;
      wake?.();
    });
    try {
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (open) {
        if (!(await authorized())) return;
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
          if (done(e)) return;
        }
        let timer: NodeJS.Timeout | undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, HEARTBEAT_MS);
        });
        clearTimeout(timer);
        wake = null;
        if (open && !queue.length) await stream.write(': keepalive\n\n');
      }
    } finally {
      unsubscribe();
    }
  });
}

const TERMINAL = new Set(['saved', 'discarded']);

/** Routes under /v1/notes. Contract: docs/api.md, "Voice notes". */
export function noteRoutes(deps: Deps, hub: NoteHub, models: ModelRegistry) {
  const app = new Hono<AppEnv>();
  const maxMs = deps.config.notes.maxSeconds * 1000;

  /** Short Clerk JWTs cannot be refreshed by a suspended web view. Mint a bounded, recorder-only token. */
  app.post('/recorder/session', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const token = 'j26r_' + randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await deps.pool.query('DELETE FROM note_recorder_sessions WHERE owner_id = $1 AND expires_at <= now()', [p.userId]);
    await deps.pool.query('INSERT INTO note_recorder_sessions(token_hash, owner_id, expires_at) VALUES ($1, $2, $3)', [hmac(deps.config.sessionSecret, 'recorder', token), p.userId, expiresAt]);
    return c.json({ token, ownerId: p.userId, expiresAt: expiresAt.toISOString() }, 201);
  });
  app.delete('/recorder/session', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (token.startsWith('j26r_')) await deps.pool.query('DELETE FROM note_recorder_sessions WHERE owner_id = $1 AND token_hash = $2', [p.userId, hmac(deps.config.sessionSecret, 'recorder', token)]);
    else await deps.pool.query('DELETE FROM note_recorder_sessions WHERE owner_id = $1', [p.userId]);
    return c.json({ ok: true });
  });

  /** Phone recorder: `start`/`stop` events for this user's notes. Keep it open while the recorder is on. */
  app.get('/recorder/events', (c) => {
    const p = c.get('principal');
    requireUser(p);
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    return sse<RecorderEvent>(c, (push) => hub.subscribeRecorder(p.userId, push), [], () => false, async () => {
      if (!token.startsWith('j26r_')) return true;
      const { rows } = await deps.pool.query('SELECT 1 FROM note_recorder_sessions WHERE owner_id = $1 AND token_hash = $2 AND expires_at > now()', [p.userId, hmac(deps.config.sessionSecret, 'recorder', token)]);
      return rows.length > 0;
    });
  });

  /** Glasses: start a note on the page that is open. Idempotent on the client-generated `id`. */
  app.post('/', async (c) => {
    const p = c.get('principal');
    requireDevice(p);
    const body = await readJson(c, StartBody);
    if (!(await getProject(deps.pool, p.userId, body.projectId))) throw notFound('Project');
    const existing = await getVoiceNote(deps.pool, p.userId, body.id);
    if (!existing && !hub.hasRecorder(p.userId)) {
      throw new ApiError(409, 'no_recorder', 'Open Solutions on your phone and turn on the note recorder.');
    }
    const r = await createVoiceNote(deps.pool, {
      id: body.id,
      ownerId: p.userId,
      projectId: body.projectId,
      releaseId: body.releaseId ?? null,
      deviceId: p.deviceId,
      viewId: body.viewId,
      stepId: body.stepId ?? null,
      pageLabel: body.pageLabel,
      noteLabel: body.noteLabel ?? null,
      stateSnapshot: body.stateSnapshot,
    });
    if (!r) throw new ApiError(409, 'id_taken', 'Use a new note id');
    if (r.created || r.note.status === 'starting') {
      hub.startOnRecorder(p.userId, {
        type: 'start',
        note: { id: r.note.id, projectId: r.note.projectId, viewId: r.note.viewId, stepId: r.note.stepId, pageLabel: r.note.pageLabel, noteLabel: r.note.noteLabel, maxSeconds: deps.config.notes.maxSeconds },
      });
      hub.setRecording(p.userId, r.note.id, maxMs);
    }
    c.get('log').info('voice note started', { noteId: r.note.id, created: r.created });
    return c.json({ note: noteView(r.note), maxSeconds: deps.config.notes.maxSeconds }, r.created ? 201 : 200);
  });

  /** Saved-note counts per page, for the glasses' "N on phone" hint. */
  app.get('/counts', async (c) => {
    const p = c.get('principal');
    userOrDevice(p);
    const projectId = c.req.query('projectId');
    if (!projectId || !uuid.safeParse(projectId).success) throw badRequest('Give ?projectId=<uuid>');
    return c.json({ counts: await countVoiceNotes(deps.pool, p.userId, projectId) });
  });

  /** Phone app: every note of an applet, newest first. */
  app.get('/', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const projectId = c.req.query('projectId');
    if (!projectId || !uuid.safeParse(projectId).success) throw badRequest('Give ?projectId=<uuid>');
    if (!(await getProject(deps.pool, p.userId, projectId))) throw notFound('Project');
    return c.json({ notes: (await listVoiceNotes(deps.pool, p.userId, projectId)).map(noteView) });
  });

  app.get('/:noteId', async (c) => {
    const p = c.get('principal');
    userOrDevice(p);
    return c.json({ note: noteView(await ownNote(deps, c)) });
  });

  /** Glasses: status of one note until it is saved or discarded. */
  app.get('/:noteId/events', async (c) => {
    const p = c.get('principal');
    userOrDevice(p);
    const note = await ownNote(deps, c);
    const first: NoteEvent[] = [{ type: 'status', noteId: note.id, status: note.status }];
    if (note.audioKey) first.push({ type: 'saved', noteId: note.id });
    else if (note.status === 'discarded') first.push({ type: 'discarded', noteId: note.id, reason: note.endReason });
    return sse<NoteEvent>(c, (push) => hub.subscribeNote(p.userId, note.id, push), first, (e) => TERMINAL.has(e.type));
  });

  /** Glasses (band pinch, WebMCP stop, time limit) or phone: ask the recorder to stop. */
  app.post('/:noteId/stop', async (c) => {
    const p = c.get('principal');
    userOrDevice(p);
    const note = await ownNote(deps, c);
    const { reason } = await readJson(c, StopBody);
    const delivered = note.audioKey || note.status === 'discarded' ? 0 : hub.stopOnRecorders(p.userId, { type: 'stop', noteId: note.id, reason });
    if (delivered) hub.toNote(p.userId, { type: 'stopping', noteId: note.id, reason });
    return c.json({ note: noteView(note), delivered: delivered > 0 });
  });

  /** Phone: recording really started. */
  app.post('/:noteId/recording', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const note = await ownNote(deps, c);
    const updated = (await markVoiceNoteRecording(deps.pool, p.userId, note.id))!;
    hub.setRecording(p.userId, note.id, maxMs);
    hub.toNote(p.userId, { type: 'recording', noteId: note.id, startedAt: new Date().toISOString() });
    return c.json({ note: noteView(updated) });
  });

  /** Phone or glasses: nothing worth keeping (too short, cancelled before speech). */
  app.post('/:noteId/discard', async (c) => {
    const p = c.get('principal');
    userOrDevice(p);
    const note = await ownNote(deps, c);
    const { reason } = await readJson(c, DiscardBody);
    const updated = (await discardVoiceNote(deps.pool, p.userId, note.id, reason))!;
    hub.clearRecording(p.userId, note.id);
    if (updated.status === 'discarded') {
      hub.stopOnRecorders(p.userId, { type: 'stop', noteId: note.id, reason: 'band' });
      hub.toNote(p.userId, { type: 'discarded', noteId: note.id, reason });
    }
    return c.json({ note: noteView(updated) });
  });

  /**
   * Phone: the trimmed recording (`audio/wav` or `audio/mpeg` body), with
   * `?durationMs=&endReason=`. Streams to storage, then queues transcription.
   * Re-sending identical bytes is a no-op.
   */
  app.put('/:noteId/audio', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const log = c.get('log');
    const note = await ownNote(deps, c);
    const mediaType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const sniff = AUDIO_TYPES[mediaType];
    if (!sniff) throw new ApiError(415, 'unsupported_media_type', 'Send audio/wav or audio/mpeg');
    const max = deps.config.notes.maxAudioBytes;
    if (Number(c.req.header('content-length') ?? '0') > max) throw new ApiError(413, 'payload_too_large', `Voice notes are limited to ${max} bytes`);
    const durationMs = c.req.query('durationMs') === undefined ? null : Number(c.req.query('durationMs'));
    if (durationMs !== null && (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > maxMs + 60_000)) throw badRequest('durationMs must be a whole number of milliseconds');
    const endReason = (c.req.query('endReason') ?? null) as VoiceNoteEndReason | null;
    if (endReason !== null && !END_REASONS.has(endReason)) throw badRequest(`endReason must be one of ${[...END_REASONS].join(', ')}`);
    const body = c.req.raw.body;
    if (!body) throw badRequest('The request body is empty');
    await assertBudget(deps, p.userId, deps.config.notes.transcribeModel);

    const key = objectKeys.voiceNote(p.userId, note.id);
    const inspector = new Inspector(max, (head) => sniff(head));
    const source = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
    const controller = new AbortController();
    const piped = source.pipe(inspector);
    source.on('error', (err) => inspector.destroy(err));
    inspector.on('error', () => controller.abort());
    try {
      await deps.store.put(key, piped, { contentType: mediaType === 'audio/mpeg' ? 'audio/mpeg' : 'audio/wav', signal: controller.signal });
      if (inspector.errored) throw inspector.errored;
    } catch (err) {
      const rejected = inspector.errored instanceof UploadRejected ? inspector.errored : err instanceof UploadRejected ? err : null;
      // Never delete audio a previous upload stored under the same key.
      if (!note.audioKey) await deps.store.delete(key).catch(() => {});
      if (rejected) throw new ApiError(rejected.status, rejected.code, rejected.message);
      log.error('voice note storage failed', { noteId: note.id, err });
      throw new ApiError(502, 'storage_unavailable', 'Could not store the recording; try again');
    }
    const sha256 = inspector.digest();
    const result = await withTransaction(deps.pool, async (tx) => {
      const stored = await storeVoiceNoteAudio(tx, p.userId, note.id, {
        key,
        mediaType: mediaType === 'audio/mpeg' ? 'audio/mpeg' : 'audio/wav',
        sha256,
        bytes: inspector.bytes,
        durationMs,
        endReason,
      });
      if (!stored) throw notFound('Note');
      const { job } = await enqueueJob(tx, {
        ownerId: p.userId,
        projectId: note.projectId,
        kind: 'transcribe_voice_note',
        input: { noteId: note.id, sha256 },
        idempotencyKey: `note:${note.id}:${sha256}`,
        maxAttempts: 4,
      });
      return { ...stored, jobId: job.id };
    });
    hub.clearRecording(p.userId, note.id);
    hub.toNote(p.userId, { type: 'saved', noteId: note.id });
    log.info('voice note stored', { noteId: note.id, bytes: inspector.bytes, durationMs, endReason, replayed: result.replayed });
    return c.json({ note: noteView(result.note), jobId: result.jobId }, result.replayed ? 200 : 201);
  });

  app.get('/:noteId/audio', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const note = await ownNote(deps, c);
    if (!note.audioKey) throw notFound('Recording');
    const object = await deps.store.get(note.audioKey);
    if (!object) throw new ApiError(500, 'audio_missing', 'The recording is unavailable');
    c.header('Content-Type', note.audioMediaType ?? object.contentType);
    c.header('Content-Length', String(object.contentLength));
    c.header('Cache-Control', 'private, max-age=3600');
    return c.body(Readable.toWeb(object.body) as ReadableStream);
  });

  /**
   * Phone, cloud fallback for live stop detection: one short `audio/wav`
   * window (the last few seconds). Answers whether it holds the stop phrase.
   * Nothing is stored or logged except outcome, model, latency and cost.
   */
  app.post('/:noteId/live', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const note = await ownNote(deps, c);
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!AUDIO_TYPES[type] || type === 'audio/mpeg') throw new ApiError(415, 'unsupported_media_type', 'Send one audio/wav window');
    if (Number(c.req.header('content-length') ?? '0') > MAX_LIVE_WINDOW_BYTES) throw new ApiError(413, 'payload_too_large', `Windows are limited to ${MAX_LIVE_WINDOW_BYTES} bytes`);
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length > MAX_LIVE_WINDOW_BYTES) throw new ApiError(413, 'payload_too_large', `Windows are limited to ${MAX_LIVE_WINDOW_BYTES} bytes`);
    if (!sniffWav(bytes)) throw new ApiError(415, 'content_mismatch', 'The body is not a WAV file');
    await assertBudget(deps, p.userId, deps.config.notes.liveModel);
    const started = performance.now();
    try {
      const r = await checkStopPhrase(models, deps.config.notes.liveModel, bytes.toString('base64'), AbortSignal.timeout(LIVE_DEADLINE_MS));
      await recordSpend(deps, p.userId, 'notes_live', r.model, r.costUsd);
      c.get('log').info('voice note live check', { noteId: note.id, stop: r.stop, model: r.model, costUsd: r.costUsd, ms: Math.round(performance.now() - started) });
      return c.json({ stop: r.stop, startSeconds: r.startSeconds });
    } catch (err) {
      if (err instanceof ModelError && err.code === 'bad_request') throw new ApiError(422, 'live_unsupported', err.message);
      c.get('log').warn('voice note live check failed', { noteId: note.id, code: err instanceof ModelError ? err.code : 'timeout' });
      throw new ApiError(503, 'live_model_unavailable', 'The stop-phrase check is unavailable right now.');
    }
  });

  /** Phone: the wearer corrected the transcript. */
  app.patch('/:noteId', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const note = await ownNote(deps, c);
    const { transcript } = await readJson(c, EditBody);
    return c.json({ note: noteView((await editVoiceNoteTranscript(deps.pool, p.userId, note.id, transcript))!) });
  });

  /** Phone: transcribe again (after a failure, or to replace an unedited transcript). */
  app.post('/:noteId/transcribe', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const note = await ownNote(deps, c);
    if (!note.audioKey || !note.audioSha256) throw new ApiError(409, 'no_audio', 'This note has no recording yet');
    await assertBudget(deps, p.userId, deps.config.notes.transcribeModel);
    const { job } = await enqueueJob(deps.pool, {
      ownerId: p.userId,
      projectId: note.projectId,
      kind: 'transcribe_voice_note',
      input: { noteId: note.id, sha256: note.audioSha256, force: true },
      idempotencyKey: `note:${note.id}:${note.audioSha256}:${Date.now()}`,
      maxAttempts: 4,
    });
    return c.json({ note: noteView(note), jobId: job.id }, 202);
  });

  app.delete('/:noteId', async (c) => {
    const p = c.get('principal');
    requireUser(p);
    const note = await ownNote(deps, c);
    const r = await deleteVoiceNote(deps.pool, p.userId, note.id);
    if (r?.audioKey) await deps.store.delete(r.audioKey).catch((err: unknown) => c.get('log').warn('could not delete voice note audio', { noteId: note.id, err }));
    hub.clearRecording(p.userId, note.id);
    return c.json({ ok: true });
  });

  return app;
}
