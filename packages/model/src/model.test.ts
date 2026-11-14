import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelRegistry, extractJson, ModelError, OpenAICompatibleProvider, parseModelSpec } from './index.ts';

test('model specs', () => {
  assert.deepEqual(parseModelSpec('openai/gpt-6-luna'), {
    provider: 'openrouter',
    model: 'openai/gpt-6-luna',
    id: 'openrouter:openai/gpt-6-luna',
  });
  assert.equal(parseModelSpec('fake:demo').provider, 'fake');
  assert.equal(parseModelSpec('openrouter:anthropic/claude-x').model, 'anthropic/claude-x');
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('sure {"a":3} done'), { a: 3 });
  assert.equal(extractJson('nope'), undefined);
});

function stubFetch(status: number, body: unknown, seen: any[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

test('openrouter request shape and usage parsing', async () => {
  const seen: any[] = [];
  const p = new OpenAICompatibleProvider({
    id: 'openrouter',
    baseUrl: 'https://x/api/v1/',
    apiKey: 'k',
    openRouter: true,
    fetch: stubFetch(
      200,
      {
        id: 'gen-1',
        model: 'openai/gpt-6-luna',
        provider: 'OpenAI',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      },
      seen,
    ),
  });
  const r = await p.complete({
    model: 'openai/gpt-6-luna',
    system: 'sys',
    maxOutputTokens: 100,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', mediaType: 'image/png', data: 'AAAA' },
        ],
      },
    ],
    responseSchema: { name: 'x', schema: { type: 'object' } },
  });
  assert.equal(seen[0].url, 'https://x/api/v1/chat/completions');
  assert.equal(seen[0].body.messages[0].role, 'system');
  assert.equal(seen[0].body.messages[1].content[1].image_url.url, 'data:image/png;base64,AAAA');
  assert.equal(seen[0].body.response_format.type, 'json_schema');
  assert.deepEqual(seen[0].body.provider, { require_parameters: true, allow_fallbacks: false });
  assert.equal(r.text, '{"ok":true}');
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
});

test('errors map to stable, retry-aware codes', async () => {
  const cases: [number, string, boolean][] = [
    [402, 'insufficient_credits', false],
    [429, 'rate_limited', true],
    [401, 'auth', false],
    [503, 'unavailable', true],
  ];
  for (const [status, code, retryable] of cases) {
    const p = new OpenAICompatibleProvider({
      id: 'o',
      baseUrl: 'https://x',
      apiKey: 'k',
      fetch: stubFetch(status, { error: { code: status, message: 'm' } }),
    });
    await assert.rejects(
      p.complete({ model: 'm', system: '', messages: [], maxOutputTokens: 1 }),
      (e: unknown) => e instanceof ModelError && e.code === code && e.retryable === retryable,
    );
  }
  const noKey = new OpenAICompatibleProvider({ id: 'o', baseUrl: 'https://x', apiKey: undefined });
  await assert.rejects(
    noKey.complete({ model: 'm', system: '', messages: [], maxOutputTokens: 1 }),
    (e: unknown) => e instanceof ModelError && e.code === 'not_configured',
  );
});

test('registry resolves configured providers only', async () => {
  const r = createModelRegistry({ fake: () => '{"reply":"hi","definition":null}' });
  const { provider, spec } = r.resolve('fake:demo');
  const out = await provider.complete({ model: spec.model, system: 's', messages: [], maxOutputTokens: 10 });
  assert.match(out.text, /hi/);
  assert.throws(
    () => r.resolve('openrouter:x'),
    (e: unknown) => e instanceof ModelError && e.code === 'not_configured',
  );
});

test('function calls and tool messages round-trip without dropping call ids', async () => {
  const seen: any[] = [];
  const p = new OpenAICompatibleProvider({
    id: 'o',
    baseUrl: 'https://x',
    apiKey: 'k',
    fetch: stubFetch(
      200,
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'call1', function: { name: 'read_url', arguments: '{"url":"https://example.com"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      seen,
    ),
  });
  const out = await p.complete({
    model: 'm',
    system: 's',
    maxOutputTokens: 100,
    tools: [{ name: 'read_url', description: 'Read', parameters: { type: 'object' } }],
    messages: [
      { role: 'assistant', content: [], toolCalls: [{ id: 'call0', name: 'read_url', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call0', content: [{ type: 'text', text: 'source' }] },
    ],
  });
  assert.equal(out.toolCalls?.[0]?.id, 'call1');
  assert.equal(out.finishReason, 'stop');
  assert.equal(seen[0].body.messages[2].tool_call_id, 'call0');
  assert.equal(seen[0].body.messages[2].content, 'source');
});

test('server search is a separate bounded Responses request with accounted usage', async () => {
  const seen: any[] = [];
  const p = new OpenAICompatibleProvider({
    id: 'openrouter',
    baseUrl: 'https://x',
    apiKey: 'k',
    openRouter: true,
    fetch: stubFetch(
      200,
      {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Facts https://example.com' }] }],
        usage: { input_tokens: 10, output_tokens: 20, cost: 0.002 },
      },
      seen,
    ),
  });
  const out = await p.complete({
    model: 'm',
    system: 'Find sources',
    maxOutputTokens: 1800,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'bowline' }] }],
    webSearch: true,
  });
  assert.equal(seen[0].url, 'https://x/responses');
  assert.equal(seen[0].body.max_tool_calls, 1);
  assert.equal(seen[0].body.tools[0].parameters.engine, 'parallel');
  assert.equal(out.usage.costUsd, 0.002);
  assert.equal(out.usage.inputTokens, 10);
  assert.match(out.text, /example.com/);
});
