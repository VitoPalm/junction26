import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from '@junction26/db/testing';
import { createProject, createVoiceNote, enqueueJob, getJobById, getVoiceNote, storeVoiceNoteAudio, upsertUserByExternalId } from '@junction26/db';
import { createModelRegistry, createTranscriptionRegistry } from '@junction26/model';
import { loadConfig, silentLogger } from '@junction26/server-common';
import { MemoryObjectStore, objectKeys } from '@junction26/storage';
import { FIXTURES, validateDefinition } from '@junction26/applet-format';
import { cleanTranscript, fakeTranscribe, transcribeVoiceNoteHandler, vocabulary } from './transcribe.ts';
import type { JobContext, WorkerDeps } from './types.ts';

function wav(text: string): Buffer {
  const data = Buffer.alloc(32_000);
  data.write(`TRANSCRIPT:${text}\0`, 100, 'latin1');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.write('WAVE', 8, 'latin1');
  return Buffer.concat([h, data]);
}

describe('cleanTranscript', () => {
  test('drops the stop command and wrappers, keeps the words', () => {
    assert.equal(cleanTranscript('Turn the heat down. Stop recording, Meta.'), 'Turn the heat down.');
    assert.equal(cleanTranscript('"Use a 5 mm hook. stop recording metta"'), 'Use a 5 mm hook.');
    assert.equal(cleanTranscript('Transcript: Row 14 was tight'), 'Row 14 was tight');
    assert.equal(cleanTranscript('(no speech)'), '');
    assert.equal(cleanTranscript('I should stop recording myself so much while knitting'), 'I should stop recording myself so much while knitting');
  });
  test('vocabulary hints come from the applet and the page', () => {
    const def = validateDefinition(FIXTURES.pancakeGuide);
    assert.ok(def.ok);
    const v = vocabulary(def.definition, { pageLabel: 'Pancake guide · Step 3', noteLabel: 'Notes on this step' });
    assert.match(v, /flour/);
    assert.ok(v.length <= 1500);
  });
});

describe('transcribe_voice_note', { skip: skipWithoutDatabase }, () => {
  let db: TestDatabase;
  let deps: WorkerDeps;
  before(async () => {
    db = await createTestDatabase();
    const config = loadConfig({ DATABASE_URL: db.url, SESSION_SECRET: 'x'.repeat(32), STORAGE_DRIVER: 'memory', NOTES_TRANSCRIBE_MODEL: 'fake:notes' });
    deps = { config, pool: db.pool, store: new MemoryObjectStore(), logger: silentLogger };
  });
  after(async () => db?.drop());

  test('writes the transcript for the queued audio only, and is safe to repeat', async () => {
    const user = await upsertUserByExternalId(db.pool, 'dev:t');
    const project = await createProject(db.pool, user.id, 'Pancakes');
    const id = crypto.randomUUID();
    await createVoiceNote(db.pool, { id, ownerId: user.id, projectId: project.id, releaseId: null, deviceId: null, viewId: 'recipe', stepId: 'heat', pageLabel: 'Step 3', noteLabel: null, stateSnapshot: null });
    const audio = wav('Medium-low heat worked better. Stop recording meta.');
    const key = objectKeys.voiceNote(user.id, id);
    await deps.store.put(key, audio, { contentType: 'audio/wav' });
    const sha = 'a'.repeat(64);
    await storeVoiceNoteAudio(db.pool, user.id, id, { key, mediaType: 'audio/wav', sha256: sha, bytes: audio.length, durationMs: 1000, endReason: 'phrase' });
    const { job } = await enqueueJob(db.pool, { ownerId: user.id, projectId: project.id, kind: 'transcribe_voice_note', input: { noteId: id, sha256: sha } });

    const models = createModelRegistry({ fake: fakeTranscribe });
    const handler = transcribeVoiceNoteHandler(models);
    const ctx: JobContext = { deps, log: silentLogger, signal: new AbortController().signal, progress: async () => {} };
    const out = await handler.run((await getJobById(db.pool, job.id))!, ctx);
    assert.equal((out.result as { status: string }).status, 'transcribed');
    const note = await getVoiceNote(db.pool, user.id, id);
    assert.equal(note?.status, 'transcribed');
    assert.equal(note?.transcript, 'Medium-low heat worked better.');
    assert.equal(note?.transcriptModel, 'fake:notes');
    // Again: no-op.
    assert.equal(((await handler.run((await getJobById(db.pool, job.id))!, ctx)).result as { replayed?: boolean }).replayed, true);
    // A job for older audio does nothing.
    const stale = await enqueueJob(db.pool, { ownerId: user.id, projectId: project.id, kind: 'transcribe_voice_note', input: { noteId: id, sha256: 'b'.repeat(64) } });
    assert.equal(((await handler.run(stale.job, ctx)).result as { status: string }).status, 'superseded');
    // Failures keep the audio and say so.
    await handler.onFailed!(job, { code: 'model_unavailable', message: 'down' }, deps);
    assert.equal((await getVoiceNote(db.pool, user.id, id))?.status, 'transcribed', 'a finished transcript is not marked failed');

    // A chat model with audio input still works when the spec isn't a transcription provider.
    const viaChat = transcribeVoiceNoteHandler(models, createTranscriptionRegistry({}));
    await viaChat.run({ ...(await getJobById(db.pool, job.id))!, input: { noteId: id, sha256: sha, force: true } }, ctx);
    assert.equal((await getVoiceNote(db.pool, user.id, id))?.transcriptModel, 'fake:notes');
  });
});
