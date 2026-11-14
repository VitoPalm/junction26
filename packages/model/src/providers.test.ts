import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider, GeminiProvider, OpenAICompatibleProvider, createModelRegistry, ModelError, parseModelSpec, type CompletionRequest } from './index.ts';

const request: CompletionRequest = { model: 'test-model', system: 'System', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], maxOutputTokens: 100, responseSchema: { name: 'answer', schema: { type: 'object', properties: { reply: { type: 'string' } } } } };
const tool = { name: 'read', description: 'Read a source', parameters: { type: 'object', properties: { page: { type: 'integer' } } } };
function mock(body: unknown, status = 200) {
  const seen: { url: string; body: any; headers: Headers }[] = [];
  const fetcher = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) });
    return Response.json(body, { status });
  }) as typeof fetch;
  return { seen, fetcher };
}

test('native Anthropic request, multimodal input, parallel tool results and cache usage', async () => {
  const { seen, fetcher } = mock({ id: 'msg1', model: 'claude-test', content: [{ type: 'text', text: 'Answer' }, { type: 'tool_use', id: 'next', name: 'read', input: { page: 2 } }], stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 } });
  const provider = new AnthropicProvider({ baseUrl: 'https://test/v1/', apiKey: 'secret', fetch: fetcher });
  const result = await provider.complete({ ...request, tools: [tool], toolChoice: 'required', messages: [
    { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }, { type: 'file', mediaType: 'application/pdf', filename: 'guide.pdf', data: 'BBBB' }] },
    { role: 'assistant', content: [], toolCalls: [{ id: 'a', name: 'read', arguments: '{"page":1}' }, { id: 'b', name: 'read', arguments: '{"page":2}' }] },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'first' }] },
    { role: 'tool', toolCallId: 'b', content: [{ type: 'text', text: 'second' }] },
  ] });
  assert.equal(seen[0]!.url, 'https://test/v1/messages');
  assert.equal(seen[0]!.headers.get('x-api-key'), 'secret');
  assert.equal(seen[0]!.headers.get('authorization'), null);
  const body = seen[0]!.body;
  assert.match(body.system, /Return only JSON matching/);
  assert.equal(body.messages[0].content[1].type, 'document');
  assert.deepEqual(body.messages[2].content.map((p: any) => p.tool_use_id), ['a', 'b']);
  assert.deepEqual(body.tools[0].input_schema, tool.parameters);
  assert.equal(body.tool_choice.type, 'any');
  assert.equal(result.toolCalls?.[0]?.arguments, '{"page":2}');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { inputTokens: 35, outputTokens: 7, costUsd: null });
});

test('Gemini keeps signed model parts and pairs parallel function results by name and id', async () => {
  const parts = [{ text: 'private thought', thought: true }, { functionCall: { id: 'a', name: 'read', args: { page: 1 } }, thoughtSignature: 'opaque-signature' }, { functionCall: { id: 'b', name: 'read', args: { page: 2 } } }];
  const { seen, fetcher } = mock({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 4 } });
  const provider = new GeminiProvider({ baseUrl: 'https://test/v1beta', apiKey: 'secret', fetch: fetcher });
  const first = await provider.complete({ ...request, tools: [tool], toolChoice: 'required', messages: [{ role: 'user', content: [{ type: 'audio', format: 'mp3', data: 'AAA' }] }] });
  assert.equal(first.text, '');
  assert.deepEqual(first.usage, { inputTokens: 12, outputTokens: 7, costUsd: null });
  assert.equal(seen[0]!.headers.get('x-goog-api-key'), 'secret');
  assert.equal(seen[0]!.body.contents[0].parts[0].inlineData.mimeType, 'audio/mpeg');
  assert.equal(seen[0]!.body.toolConfig.functionCallingConfig.mode, 'ANY');
  await provider.complete({ ...request, messages: [
    ...request.messages,
    { role: 'assistant', content: [], toolCalls: first.toolCalls, providerState: first.providerState },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'first' }] },
    { role: 'tool', toolCallId: 'b', content: [{ type: 'text', text: 'second' }] },
  ] });
  assert.deepEqual(seen[1]!.body.contents[1].parts, parts);
  assert.deepEqual(seen[1]!.body.contents[2].parts.map((p: any) => p.functionResponse.id), ['a', 'b']);
  assert.equal(seen[1]!.body.contents[2].parts[0].functionResponse.name, 'read');
});

test('compatible providers support keyless local endpoints, all output modes and token parameters', async () => {
  for (const responseFormat of ['prompt', 'json_object', 'json_schema'] as const) {
    const { seen, fetcher } = mock({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    const provider = new OpenAICompatibleProvider({ id: 'local', baseUrl: 'http://localhost/v1', apiKey: undefined, auth: 'none', responseFormat, tokenParameter: 'max_completion_tokens', fetch: fetcher });
    await provider.complete(request);
    const body = seen[0]!.body;
    assert.equal(body.max_completion_tokens, 100);
    assert.equal(body.max_tokens, undefined);
    assert.equal(seen[0]!.headers.get('authorization'), null);
    assert.equal(body.response_format?.type, responseFormat === 'prompt' ? undefined : responseFormat);
    if (responseFormat !== 'json_schema') assert.match(body.messages[0].content, /Return only JSON/);
    assert.equal(body.messages[1].content, 'Hello');
  }
});

test('model overrides disable unsupported input and use prompt schema guidance', async () => {
  const { seen, fetcher } = mock({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
  const provider = new OpenAICompatibleProvider({ id: 'local', baseUrl: 'https://test', apiKey: 'k', fetch: fetcher, modelCapabilities: { 'test-model': { structuredOutput: false, images: false, tools: false } } });
  await provider.complete(request);
  assert.equal(seen[0]!.body.response_format, undefined);
  assert.match(seen[0]!.body.messages[0].content, /Return only JSON/);
  await assert.rejects(provider.complete({ ...request, tools: [tool] }), ModelError);
  await assert.rejects(provider.complete({ ...request, messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }] }), ModelError);
  assert.equal(seen.length, 1);
});

test('registry preserves provider identity and does not route a typo to OpenRouter', () => {
  assert.equal(parseModelSpec('anthropic:claude-test').provider, 'anthropic');
  assert.equal(parseModelSpec('gemini:gemini-test').provider, 'gemini');
  assert.equal(parseModelSpec('meta/model:free').model, 'meta/model:free');
  const registry = createModelRegistry({ anthropic: { baseUrl: 'https://test', apiKey: undefined }, gemini: { baseUrl: 'https://test', apiKey: 'k' }, compatible: [{ id: 'local', baseUrl: 'http://localhost/v1', apiKey: undefined, auth: 'none' }] });
  assert.equal(registry.resolve('anthropic:test').provider.configured, false);
  assert.equal(registry.resolve('gemini:test').provider.configured, true);
  assert.equal(registry.resolve('local:llama:latest').spec.model, 'llama:latest');
  assert.throws(() => registry.resolve('typo:model'), (e: unknown) => e instanceof ModelError && e.code === 'not_configured');
  assert.throws(() => parseModelSpec('gemini:'), ModelError);
  assert.throws(() => registry.register(registry.resolve('local:test').provider), ModelError);
});

test('native finish reasons, blocked prompts, malformed responses and missing credentials', async () => {
  for (const [kind, response, expected] of [
    ['anthropic', { content: [], stop_reason: 'max_tokens' }, 'length'],
    ['anthropic', { content: [], stop_reason: 'refusal' }, 'content_filter'],
    ['gemini', { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }, 'length'],
    ['gemini', { promptFeedback: { blockReason: 'SAFETY' } }, 'content_filter'],
  ] as const) {
    const { fetcher } = mock(response);
    const options = { baseUrl: 'https://test', apiKey: 'k', fetch: fetcher };
    const provider = kind === 'anthropic' ? new AnthropicProvider(options) : new GeminiProvider(options);
    assert.equal((await provider.complete(request)).finishReason, expected);
  }
  for (const Provider of [AnthropicProvider, GeminiProvider, OpenAICompatibleProvider]) {
    const { fetcher } = mock({});
    await assert.rejects(new Provider({ id: 'test', baseUrl: 'https://test', apiKey: 'k', fetch: fetcher }).complete(request), (e: unknown) => e instanceof ModelError && e.code === 'invalid_response');
    await assert.rejects(new Provider({ id: 'test', baseUrl: 'https://test', apiKey: undefined, fetch: fetcher }).complete(request), (e: unknown) => e instanceof ModelError && e.code === 'not_configured');
  }
});

test('all transports normalize errors without exposing payloads and preserve cancellation', async () => {
  for (const Provider of [AnthropicProvider, GeminiProvider, OpenAICompatibleProvider]) {
    for (const [status, detail, expected, retryable] of [
      [401, {}, 'auth', false], [402, {}, 'insufficient_credits', false],
      [429, {}, 'rate_limited', true], [429, { code: 'insufficient_quota' }, 'insufficient_credits', false],
      [400, { message: 'maximum context tokens' }, 'context_too_long', false], [529, {}, 'unavailable', true],
    ] as const) {
      const { fetcher } = mock({ error: { ...detail, secret: 'NEVER_EXPOSE' } }, status);
      const provider = new Provider({ id: 'test', baseUrl: 'https://test', apiKey: 'k', fetch: fetcher });
      await assert.rejects(provider.complete(request), (e: unknown) => e instanceof ModelError && e.code === expected && e.retryable === retryable && !e.message.includes('NEVER_EXPOSE'));
    }
    const ac = new AbortController(); ac.abort(new Error('cancelled'));
    const { fetcher, seen } = mock({});
    const provider = new Provider({ id: 'test', baseUrl: 'https://test', apiKey: 'k', fetch: fetcher });
    await assert.rejects(provider.complete({ ...request, signal: ac.signal }), /cancelled/);
    assert.equal(seen.length, 0);
  }
});

test('timeout and cancellation include response body reads', async () => {
  const bodyFetch = (async (_url: any, init: any) => ({ ok: true, text: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) })) as typeof fetch;
  const provider = new OpenAICompatibleProvider({ id: 'test', baseUrl: 'https://test', apiKey: 'k', timeoutMs: 5, fetch: bodyFetch });
  // AbortSignal.timeout is unref'ed; retain a handle while the stub waits.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(provider.complete(request), (e: unknown) => e instanceof ModelError && e.code === 'timeout'); }
  finally { clearTimeout(keepAlive); }
});
