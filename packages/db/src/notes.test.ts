import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from './testing.ts';
import {
  countVoiceNotes,
  createProject,
  createVoiceNote,
  deleteVoiceNote,
  discardVoiceNote,
  editVoiceNoteTranscript,
  enqueueJob,
  finishVoiceNoteTranscript,
  getVoiceNote,
  listVoiceNotes,
  markVoiceNoteRecording,
  markVoiceNoteTranscribing,
  storeVoiceNoteAudio,
  upsertUserByExternalId,
} from './index.ts';

const sha = (c: string) => c.repeat(64);

describe('voice notes', { skip: skipWithoutDatabase }, () => {
  let db: TestDatabase;
  before(async () => {
    db = await createTestDatabase();
  });
  after(async () => db?.drop());

  test('lifecycle: start (idempotent) → recording → audio → transcript; ownership enforced', async () => {
    const alice = await upsertUserByExternalId(db.pool, 'dev:alice-notes');
    const bob = await upsertUserByExternalId(db.pool, 'dev:bob-notes');
    const project = await createProject(db.pool, alice.id, 'Pancakes');
    const id = crypto.randomUUID();
    const args = { id, ownerId: alice.id, projectId: project.id, releaseId: null, deviceId: null, viewId: 'recipe', stepId: 'heat', pageLabel: 'Pancakes · Step 3', noteLabel: null, stateSnapshot: { step: 'heat' } };
    const first = await createVoiceNote(db.pool, args);
    assert.equal(first?.created, true);
    assert.equal(first?.note.status, 'starting');
    const again = await createVoiceNote(db.pool, args);
    assert.equal(again?.created, false);
    // Someone else can't claim or read the id.
    assert.equal(await createVoiceNote(db.pool, { ...args, ownerId: bob.id }), null);
    assert.equal(await getVoiceNote(db.pool, bob.id, id), null);

    // Not listed or counted until there is audio.
    assert.equal((await listVoiceNotes(db.pool, alice.id, project.id)).length, 0);
    assert.equal((await markVoiceNoteRecording(db.pool, alice.id, id))?.status, 'recording');
    assert.equal((await listVoiceNotes(db.pool, alice.id, project.id)).length, 1);
    assert.deepEqual(await countVoiceNotes(db.pool, alice.id, project.id), []);

    const audio = { key: `notes/${alice.id}/${id}/audio`, mediaType: 'audio/wav', sha256: sha('a'), bytes: 1000, durationMs: 4200, endReason: 'phrase' as const };
    assert.equal(await storeVoiceNoteAudio(db.pool, bob.id, id, audio), null);
    const stored = await storeVoiceNoteAudio(db.pool, alice.id, id, audio);
    assert.equal(stored?.replayed, false);
    assert.equal(stored?.note.status, 'uploaded');
    assert.equal((await storeVoiceNoteAudio(db.pool, alice.id, id, audio))?.replayed, true);
    assert.deepEqual(await countVoiceNotes(db.pool, alice.id, project.id), [{ viewId: 'recipe', stepId: 'heat', count: 1 }]);
    // Audio is never discarded.
    assert.equal((await discardVoiceNote(db.pool, alice.id, id, 'too_short'))?.status, 'uploaded');

    // The job may only finish the transcript for the audio it was queued for.
    assert.equal(await markVoiceNoteTranscribing(db.pool, id, sha('b')), false);
    assert.equal(await markVoiceNoteTranscribing(db.pool, id, sha('a')), true);
    assert.equal(await finishVoiceNoteTranscript(db.pool, id, sha('b'), 'stale', 'fake:notes'), false);
    assert.equal(await finishVoiceNoteTranscript(db.pool, id, sha('a'), 'Heat was too high.', 'fake:notes'), true);
    let note = await getVoiceNote(db.pool, alice.id, id);
    assert.equal(note?.status, 'transcribed');
    assert.equal(note?.transcript, 'Heat was too high.');

    // Edits win over later transcriptions.
    await editVoiceNoteTranscript(db.pool, alice.id, id, 'Heat was much too high.');
    await finishVoiceNoteTranscript(db.pool, id, sha('a'), 'Machine text', 'fake:notes');
    note = await getVoiceNote(db.pool, alice.id, id);
    assert.equal(note?.transcript, 'Heat was much too high.');
    assert.equal(note?.transcriptEdited, true);

    assert.equal(await deleteVoiceNote(db.pool, bob.id, id), null);
    assert.deepEqual(await deleteVoiceNote(db.pool, alice.id, id), { audioKey: audio.key });
    assert.equal(await getVoiceNote(db.pool, alice.id, id), null);
  });

  test('a note without audio can be discarded; the transcription job kind is allowed', async () => {
    const alice = await upsertUserByExternalId(db.pool, 'dev:carol-notes');
    const project = await createProject(db.pool, alice.id, 'Rows');
    const id = crypto.randomUUID();
    await createVoiceNote(db.pool, { id, ownerId: alice.id, projectId: project.id, releaseId: null, deviceId: null, viewId: 'counter', stepId: null, pageLabel: 'Rows', noteLabel: 'Pattern notes', stateSnapshot: null });
    assert.equal((await discardVoiceNote(db.pool, alice.id, id, 'too_short'))?.status, 'discarded');
    const { job } = await enqueueJob(db.pool, { ownerId: alice.id, projectId: project.id, kind: 'transcribe_voice_note', input: { noteId: id, sha256: sha('c') } });
    assert.equal(job.kind, 'transcribe_voice_note');
  });
});
