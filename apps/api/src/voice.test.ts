import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithoutDatabase } from '@junction26/db/testing';
import { createModelRegistry } from '@junction26/model';
import { createHarness, type Harness } from './test-support/harness.ts';
import { CONTEXT_TTL_MS, fakeVoice, parseVoiceResult, resolveUtterance, VoiceHub, type VoiceContext } from './voice.ts';

const context: VoiceContext = {
  projectId: 'demo-rows',
  title: 'Row counter',
  view: 'main',
  state: 'Rows: 4',
  tools: [
    {
      name: 'j26rc_add_rows',
      description: 'Add rows to the row counter (Row counter). Examples: "add a row".',
      parameters: { type: 'object', properties: { amount: { type: 'integer', description: 'How many rows' } }, required: [] },
    },
    { name: 'j26rc_reset', description: 'Reset the counter to zero (Row counter).', parameters: { type: 'object', properties: {}, required: [] } },
    { name: 'j26rc_read_state', description: 'Read the current values of the open applet.', parameters: { type: 'object', properties: {}, required: [] } },
  ],
};

const models = createModelRegistry({ fake: fakeVoice });

describe('voice resolver', () => {
  test('a command picks the matching tool and fills numbers, without the transcript field', async () => {
    const { resolution } = await resolveUtterance(models, 'fake:voice', context, { kind: 'text', text: 'add two rows' });
    assert.deepEqual(resolution, { outcome: 'command', tool: 'j26rc_add_rows', args: { amount: 2 }, heard: 'add two rows' });
  });

  test('chatter is ignored', async () => {
    const { resolution } = await resolveUtterance(models, 'fake:voice', context, { kind: 'text', text: 'did you see the game last night' });
    assert.equal(resolution.outcome, 'ignored');
  });

  test('the model may only choose tools from the open applet', () => {
    const r = parseVoiceResult(context, { name: 'j26other_delete_everything', arguments: '{"heard_text":"x"}' }, '');
    assert.deepEqual(r, { outcome: 'ignored', heard: 'x', reason: 'unknown_tool' });
    assert.equal(parseVoiceResult(context, { name: 'j26rc_reset', arguments: 'not json' }, 'y').outcome, 'ignored');
    assert.equal(parseVoiceResult(context, undefined, 'z').outcome, 'ignored');
  });

  test('audio to a model without audio input is refused before any call', async () => {
    const r = createModelRegistry({ openAI: { apiKey: 'k', baseUrl: 'https://unused.invalid' } });
    await assert.rejects(resolveUtterance(r, 'openai:gpt-6-luna', context, { kind: 'audio', format: 'wav', data: 'AA==' }), /doesn't accept audio/);
  });
});

describe('voice hub', () => {
  test('targets only listening glasses with a fresh context, per owner', () => {
    let now = 1000;
    const hub = new VoiceHub(() => now);
    hub.setContext('alice', 'd1', context);
    assert.equal(hub.target('alice'), null, 'context without a listener');
    const got: string[] = [];
    const off = hub.subscribe('alice', 'd1', (e) => got.push(e.tool));
    assert.equal(hub.target('alice')?.deviceId, 'd1');
    assert.equal(hub.target('bob'), null, 'other owners never see it');
    assert.equal(hub.publish('bob', 'd1', { id: 'x', tool: 't', args: {}, heard: '' }), 0);
    assert.equal(hub.publish('alice', 'd1', { id: 'x', tool: 't', args: {}, heard: '' }), 1);
    assert.deepEqual(got, ['t']);
    now += CONTEXT_TTL_MS + 1;
    assert.equal(hub.target('alice'), null, 'stale context');
    off();
  });
});

describe('voice api', { skip: skipWithoutDatabase }, () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ VOICE_MODEL: 'fake:voice' });
  });
  after(async () => h?.close());

  async function pairDevice(token: string) {
    const code = await h.call('POST', '/v1/devices/pairing-codes', { token });
    const paired = await h.call('POST', '/v1/devices/pair', { body: { code: code.body.code, label: 'MRBD' } });
    return paired.body.token as string;
  }

  test('bridge utterance → command event on the owner’s glasses', async () => {
    const glasses = await pairDevice('dev:alice');
    assert.equal((await h.call('PUT', '/v1/voice/context', { token: 'dev:alice', body: context })).status, 403, 'context is device-only');
    assert.equal((await h.call('PUT', '/v1/voice/context', { token: glasses, body: context })).status, 200);

    // Nobody listening yet: no model call, honest outcome.
    const early = await h.call('POST', '/v1/voice/utterances', { token: 'dev:alice', body: { text: 'add two rows' } });
    assert.equal(early.body.outcome, 'no_glasses');

    const ac = new AbortController();
    const res = await h.app.request('/v1/voice/events', { headers: { authorization: `Bearer ${glasses}` }, signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const nextEvent = async (name: string) => {
      for (;;) {
        const m = new RegExp(`event: ${name}\\ndata: (.*)\\n`).exec(buf);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return JSON.parse(m[1]!);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += dec.decode(value);
      }
    };
    await nextEvent('ready');

    const r = await h.call('POST', '/v1/voice/utterances', { token: 'dev:alice', body: { text: 'add two rows' }, headers: { 'x-utterance-id': 'utt-00000001' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, 'command');
    assert.deepEqual(await nextEvent('command'), { id: 'utt-00000001', tool: 'j26rc_add_rows', args: { amount: 2 }, heard: 'add two rows' });

    // A retried upload doesn't act twice.
    const retry = await h.call('POST', '/v1/voice/utterances', { token: 'dev:alice', body: { text: 'add two rows' }, headers: { 'x-utterance-id': 'utt-00000001' } });
    assert.deepEqual(retry.body, r.body);

    const chatter = await h.call('POST', '/v1/voice/utterances', { token: 'dev:alice', body: { text: 'what time is dinner' } });
    assert.equal(chatter.body.outcome, 'ignored');

    const bob = await h.call('POST', '/v1/voice/utterances', { token: 'dev:bob', body: { text: 'add two rows' } });
    assert.equal(bob.body.outcome, 'no_glasses', 'other users never reach these glasses');

    const fakeAudio = await h.call('POST', '/v1/voice/utterances', { token: 'dev:alice', body: new Uint8Array([82, 73, 70, 70]), headers: { 'content-type': 'audio/wav' } });
    assert.equal(fakeAudio.body.outcome, 'ignored', 'the fake model ignores audio');
    assert.equal((await h.call('POST', '/v1/voice/utterances', { token: 'dev:alice', body: 'hi', headers: { 'content-type': 'text/plain' } })).status, 415);

    ac.abort();
    await reader.cancel().catch(() => {});
  });
});
