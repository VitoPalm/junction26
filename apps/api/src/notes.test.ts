import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithoutDatabase } from '@junction26/db/testing';
import { getJobById } from '@junction26/db';
import { createHarness, type Harness } from './test-support/harness.ts';
import { NoteHub, parseLive } from './notes.ts';

const ALICE = 'dev:alice';
const BOB = 'dev:bob';

/** A tiny valid WAV (16 kHz mono PCM16). `marker` bytes go into the data chunk (the fake live model "hears" them). */
export function wav(ms: number, marker = ''): Buffer {
  const samples = Math.round((16000 * ms) / 1000);
  const data = Buffer.alloc(samples * 2);
  data.write(marker, Math.max(0, data.length - marker.length - 2), 'latin1');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Reads server-sent events from a streaming response. */
function events(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return {
    async next(type: string, timeoutMs = 2000): Promise<any> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === type) return data ? JSON.parse(data) : null;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`no ${type} event`);
        const r = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no ${type} event`)), left))]);
        if (r.done) throw new Error('stream ended');
        buf += dec.decode(r.value, { stream: true });
      }
    },
    close: () => reader.cancel(),
  };
}

describe('voice notes api', { skip: skipWithoutDatabase }, () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ NOTES_LIVE_MODEL: 'fake:live', VOICE_MODEL: 'fake:voice', NOTES_MAX_SECONDS: '60' });
  });
  after(async () => h?.close());

  async function setup(token = ALICE) {
    const project = (await h.call('POST', '/v1/projects', { token, body: { title: 'Pancakes' } })).body.project.id as string;
    const code = await h.call('POST', '/v1/devices/pairing-codes', { token });
    const paired = await h.call('POST', '/v1/devices/pair', { body: { code: code.body.code, label: 'MRBD' } });
    return { project, device: paired.body.token as string };
  }
  const sse = async (path: string, token: string) => {
    const res = await h.app.request(path, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    return events(res);
  };
  const start = (device: string, project: string, id = crypto.randomUUID()) =>
    h.call('POST', '/v1/notes', { token: device, body: { id, projectId: project, viewId: 'recipe', stepId: 'heat', pageLabel: 'Pancakes · Step 3', noteLabel: 'Notes on this step', stateSnapshot: { Step: '3 of 5' } } });

  test('native recorder credentials are owner scoped, bounded, revocable and cannot author or read notes', async () => {
    const { project, device } = await setup();
    const session = await h.call('POST', '/v1/notes/recorder/session', { token: ALICE });
    assert.equal(session.status, 201);
    const token = session.body.token;
    assert.match(token, /^j26r_/);
    assert.ok(Date.parse(session.body.expiresAt) <= Date.now() + 12 * 60 * 60 * 1000);
    assert.equal((await h.call('POST', '/v1/notes/recorder/session', { token: device })).status, 403);
    for (const [method, path] of [['GET', '/v1/projects'], ['POST', '/v1/projects'], ['GET', `/v1/notes?projectId=${project}`], ['POST', '/v1/notes/recorder/session']]) {
      assert.equal((await h.call(method!, path!, { token })).status, 403);
    }
    const recorder = await sse('/v1/notes/recorder/events', token);
    await recorder.next('ready');
    const note = await start(device, project); const id = note.body.note.id;
    assert.equal((await h.call('POST', `/v1/notes/${id}/recording`, { token })).status, 200);
    const bobSession = await h.call('POST', '/v1/notes/recorder/session', { token: BOB });
    assert.equal((await h.call('POST', `/v1/notes/${id}/recording`, { token: bobSession.body.token })).status, 404);
    assert.equal((await h.call('GET', `/v1/notes/${id}/audio`, { token })).status, 403);
    assert.equal((await h.call('DELETE', '/v1/notes/recorder/session', { token })).status, 200);
    assert.equal((await h.call('POST', `/v1/notes/${id}/recording`, { token })).status, 401);
    const expired = await h.call('POST', '/v1/notes/recorder/session', { token: ALICE });
    await h.db.pool.query("UPDATE note_recorder_sessions SET expires_at = now() - interval '1 second' WHERE owner_id = $1", [expired.body.ownerId]);
    assert.equal((await h.call('POST', `/v1/notes/${id}/recording`, { token: expired.body.token })).status, 401);
    await recorder.close();
  });

  test('full loop: glasses start → phone records → audio saved → transcription queued', async () => {
    const { project, device } = await setup();
    // No recorder open: refused, nothing created.
    const refused = await start(device, project);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'no_recorder');

    const recorder = await sse('/v1/notes/recorder/events', ALICE);
    await recorder.next('ready');
    const id = crypto.randomUUID();
    const started = await start(device, project, id);
    assert.equal(started.status, 201);
    assert.equal(started.body.note.status, 'starting');
    assert.equal(started.body.maxSeconds, 60);
    const ev = await recorder.next('start');
    assert.equal(ev.note.id, id);
    assert.equal(ev.note.stepId, 'heat');
    // A retried start is idempotent.
    assert.equal((await start(device, project, id)).status, 200);

    const glasses = await sse(`/v1/notes/${id}/events`, device);
    assert.equal((await glasses.next('status')).status, 'starting');

    // While a note is recording, voice commands are paused.
    const paused = await h.call('POST', '/v1/voice/utterances', { token: ALICE, body: { text: 'add two rows' } });
    assert.equal(paused.body.outcome, 'paused');

    assert.equal((await h.call('POST', `/v1/notes/${id}/recording`, { token: ALICE })).body.note.status, 'recording');
    assert.ok((await glasses.next('recording')).startedAt);

    // The band asks to stop; the phone hears it.
    const stop = await h.call('POST', `/v1/notes/${id}/stop`, { token: device, body: { reason: 'band' } });
    assert.equal(stop.body.delivered, true);
    assert.equal((await recorder.next('stop')).reason, 'band');
    assert.equal((await glasses.next('stopping')).reason, 'band');

    // Live check (fake model "hears" the marker bytes).
    const live = await h.call('POST', `/v1/notes/${id}/live`, { token: ALICE, body: wav(3000, 'stop recording meta'), headers: { 'content-type': 'audio/wav' } });
    assert.equal(live.status, 200);
    assert.equal(live.body.stop, true);
    const quiet = await h.call('POST', `/v1/notes/${id}/live`, { token: ALICE, body: wav(3000), headers: { 'content-type': 'audio/wav' } });
    assert.equal(quiet.body.stop, false);

    // Upload.
    const audio = wav(4000);
    const up = await h.call('PUT', `/v1/notes/${id}/audio?durationMs=4000&endReason=phrase`, { token: ALICE, body: audio, headers: { 'content-type': 'audio/wav' } });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.note.status, 'uploaded');
    assert.equal(up.body.note.endReason, 'phrase');
    await glasses.next('saved');
    const job = await getJobById(h.db.pool, up.body.jobId);
    assert.equal(job?.kind, 'transcribe_voice_note');
    assert.equal(job?.input.noteId, id);
    // Same bytes again: replay, same job.
    const again = await h.call('PUT', `/v1/notes/${id}/audio?durationMs=4000&endReason=phrase`, { token: ALICE, body: audio, headers: { 'content-type': 'audio/wav' } });
    assert.equal(again.status, 200);
    assert.equal(again.body.jobId, up.body.jobId);
    // Voice commands resume.
    assert.notEqual((await h.call('POST', '/v1/voice/utterances', { token: ALICE, body: { text: 'add two rows' } })).body.outcome, 'paused');

    // Phone app views.
    const list = await h.call('GET', `/v1/notes?projectId=${project}`, { token: ALICE });
    assert.equal(list.body.notes.length, 1);
    assert.equal(list.body.notes[0].audio.url, `/v1/notes/${id}/audio`);
    assert.equal(list.body.notes[0].audioKey, undefined, 'object keys stay private');
    const counts = await h.call('GET', `/v1/notes/counts?projectId=${project}`, { token: device });
    assert.deepEqual(counts.body.counts, [{ viewId: 'recipe', stepId: 'heat', count: 1 }]);
    const file = await h.app.request(`/v1/notes/${id}/audio`, { headers: { authorization: `Bearer ${ALICE}` } });
    assert.equal(file.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await file.arrayBuffer()).length, audio.length);
    const edited = await h.call('PATCH', `/v1/notes/${id}`, { token: ALICE, body: { transcript: 'Medium-low heat next time.' } });
    assert.equal(edited.body.note.transcriptEdited, true);
    assert.equal((await h.call('POST', `/v1/notes/${id}/transcribe`, { token: ALICE })).status, 202);

    recorder.close();
    glasses.close();
    assert.equal((await h.call('DELETE', `/v1/notes/${id}`, { token: ALICE })).status, 200);
    assert.equal((await h.call('GET', `/v1/notes/${id}`, { token: ALICE })).status, 404);
  });

  test('ownership and input checks', async () => {
    const { project, device } = await setup();
    const recorder = await sse('/v1/notes/recorder/events', ALICE);
    await recorder.next('ready');
    const id = crypto.randomUUID();
    assert.equal((await start(device, project, id)).status, 201);
    for (const [method, path] of [
      ['GET', `/v1/notes/${id}`],
      ['GET', `/v1/notes/${id}/audio`],
      ['POST', `/v1/notes/${id}/recording`],
      ['DELETE', `/v1/notes/${id}`],
      ['GET', `/v1/notes?projectId=${project}`],
    ] as const) {
      assert.equal((await h.call(method, path, { token: BOB })).status, 404, `${method} ${path}`);
    }
    // Bob's glasses can't start a note on Alice's project.
    const bob = await setup(BOB);
    assert.equal((await start(bob.device, project)).status, 404);
    // Only phones (user sessions) upload; only glasses start.
    assert.equal((await h.call('PUT', `/v1/notes/${id}/audio`, { token: device, body: wav(500), headers: { 'content-type': 'audio/wav' } })).status, 403);
    assert.equal((await h.call('POST', '/v1/notes', { token: ALICE, body: {} })).status, 403);
    // Content must match the type.
    const bad = await h.call('PUT', `/v1/notes/${id}/audio`, { token: ALICE, body: Buffer.from('not audio at all, really'), headers: { 'content-type': 'audio/wav' } });
    assert.equal(bad.status, 415);
    assert.equal((await h.call('GET', `/v1/notes/${id}`, { token: ALICE })).body.note.audio, null);
    // Too short: discarded, and not listed.
    assert.equal((await h.call('POST', `/v1/notes/${id}/discard`, { token: ALICE, body: { reason: 'too_short' } })).body.note.status, 'discarded');
    assert.equal((await h.call('GET', `/v1/notes?projectId=${project}`, { token: ALICE })).body.notes.length, 0);
    recorder.close();
  });
});

describe('note hub', () => {
  test('starts go to the newest recorder only; stops to all; owners are separate', () => {
    let now = 0;
    const hub = new NoteHub(() => now);
    const a: string[] = [];
    const b: string[] = [];
    hub.subscribeRecorder('alice', (e) => a.push(e.type));
    now = 10;
    const offB = hub.subscribeRecorder('alice', (e) => b.push(e.type));
    const note = { id: 'n', projectId: 'p', viewId: 'v', stepId: null, pageLabel: 'P', noteLabel: null, maxSeconds: 60 };
    assert.equal(hub.startOnRecorder('alice', { type: 'start', note }), true);
    assert.deepEqual([a, b], [[], ['start']]);
    hub.stopOnRecorders('alice', { type: 'stop', noteId: 'n', reason: 'band' });
    assert.deepEqual([a, b], [['stop'], ['start', 'stop']]);
    assert.equal(hub.startOnRecorder('bob', { type: 'start', note }), false);
    offB();
    assert.equal(hub.hasRecorder('alice'), true);
    hub.setRecording('alice', 'n', 1000);
    assert.equal(hub.isRecording('alice'), true);
    assert.equal(hub.isRecording('bob'), false);
    now = 10 + 1000 + 60_001;
    assert.equal(hub.isRecording('alice'), false, 'a lost upload never pauses voice forever');
  });

  test('live answers parse defensively', () => {
    assert.deepEqual(parseLive('{"stop":true,"start_seconds":2.5}'), { stop: true, startSeconds: 2.5 });
    assert.deepEqual(parseLive('sure! {"stop": false, "start_seconds": 1}'), { stop: false, startSeconds: null });
    assert.deepEqual(parseLive('nonsense'), { stop: false, startSeconds: null });
  });
});
