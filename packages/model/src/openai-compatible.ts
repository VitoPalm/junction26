import {
  ModelError,
  type CompletionRequest,
  type CompletionResult,
  type ModelCapabilities,
  type ModelProvider,
  type Part,
} from './types.ts';

export interface OpenAICompatibleOptions {
  /** Registry key ("openrouter", or e.g. "openai", "local"). */
  id: string;
  baseUrl: string;
  apiKey: string | undefined;
  /** Enables OpenRouter-only request fields (provider routing, usage accounting). */
  openRouter?: boolean;
  /** Extra headers (OpenRouter app attribution etc.). Never put secrets other than the key here. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Chat Completions over HTTP. Covers OpenRouter (any model it routes) and any
 * OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, OpenAI itself).
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly o: OpenAICompatibleOptions;
  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.o = options;
  }

  capabilities(model: string): ModelCapabilities {
    // Conservative defaults; refine per model as they're tested.
    const vision = /gpt|claude|gemini|luna|vision|vl|llava|qwen.*vl/i.test(model);
    return { images: vision, files: this.o.openRouter === true, structuredOutput: true };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.o.apiKey) throw new ModelError('not_configured', `No API key for model provider "${this.id}"`);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({
          role: m.role,
          content:
            m.role === 'tool'
              ? m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
              : m.content.map(toWire),
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((t) => ({
                  id: t.id,
                  type: 'function',
                  function: { name: t.name, arguments: t.arguments },
                })),
              }
            : {}),
        })),
      ],
      max_tokens: req.maxOutputTokens,
    };
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
    if (req.webSearch && !this.o.openRouter) throw new ModelError('bad_request', 'Web search requires OpenRouter');
    if (req.responseSchema) {
      body.response_format = {
        type: 'json_schema',
        // Not strict: OpenAI strict mode forbids optional properties, which the
        // applet format relies on. We validate locally either way.
        json_schema: { name: req.responseSchema.name, strict: false, schema: req.responseSchema.schema },
      };
    }
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
    if (this.o.openRouter) {
      body.usage = { include: true };
      // Only route to endpoints that honour response_format; don't silently fall back to another model.
      body.provider = { require_parameters: true, allow_fallbacks: false };
    }

    if (req.webSearch) {
      delete body.messages;
      delete body.max_tokens;
      body.input = req.messages.flatMap((m) =>
        m.content
          .filter((p) => p.type === 'text')
          .map((p) => ({ role: m.role, content: (p as { text: string }).text })),
      );
      body.instructions = req.system;
      body.max_output_tokens = req.maxOutputTokens;
      body.tools = [
        {
          type: 'openrouter:web_search',
          parameters: { engine: 'parallel', mode: 'fast', max_results: 3, max_total_results: 3, max_characters: 3000 },
        },
      ];
      body.max_tool_calls = 1;
    }
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 180_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(
        `${this.o.baseUrl.replace(/\/$/, '')}/${req.webSearch ? 'responses' : 'chat/completions'}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}`, ...this.o.headers },
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch (err) {
      if (req.signal?.aborted) throw err;
      if (timeout.aborted) throw new ModelError('timeout', 'The model took too long to answer');
      throw new ModelError('unavailable', `Could not reach the model provider: ${(err as Error).message}`);
    }
    const raw = await res.text();
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      throw res.ok
        ? new ModelError('invalid_response', 'The provider returned non-JSON')
        : statusError(res.status, raw.slice(0, 200));
    }
    if (!res.ok || json.error)
      throw statusError(json.error?.code ?? res.status, json.error?.message ?? `HTTP ${res.status}`);

    const choice = json.choices?.[0];
    const searchText = req.webSearch
      ? (json.output ?? [])
          .filter((i: any) => i.type === 'message')
          .flatMap((i: any) => i.content ?? [])
          .filter((i: any) => i.type === 'output_text')
          .map((i: any) => i.text)
          .join('\n')
      : undefined;
    const content = choice?.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((p: any) => p.text ?? '').join('')
          : '';
    const fr = choice?.finish_reason;
    return {
      text: searchText ?? text,
      toolCalls: choice?.message?.tool_calls?.map((t: any) => ({
        id: t.id,
        name: t.function?.name,
        arguments: t.function?.arguments,
      })),
      finishReason:
        fr === 'stop' || json.status === 'completed' || fr === 'tool_calls'
          ? 'stop'
          : fr === 'length'
            ? 'length'
            : fr === 'content_filter'
              ? 'content_filter'
              : 'other',
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? json.usage?.output_tokens ?? 0,
        costUsd: typeof json.usage?.cost === 'number' ? json.usage.cost : null,
      },
      provider: json.provider ?? this.id,
      model: json.model ?? req.model,
      requestId: json.id ?? null,
    };
  }
}

function toWire(p: Part): unknown {
  switch (p.type) {
    case 'text':
      return { type: 'text', text: p.text };
    case 'image':
      return { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } };
    case 'file':
      return { type: 'file', file: { filename: p.filename, file_data: `data:${p.mediaType};base64,${p.data}` } };
  }
}

function statusError(status: number | string, message: string): ModelError {
  const s = typeof status === 'string' ? Number(status) || 0 : status;
  const m = String(message);
  if (s === 401 || s === 403) return new ModelError('auth', `The model provider refused the key: ${m}`, s);
  if (s === 402) return new ModelError('insufficient_credits', 'The authoring budget is used up', s);
  if (s === 429) return new ModelError('rate_limited', 'The model provider is rate limiting us', s);
  if (s === 408) return new ModelError('timeout', m, s);
  if (s === 400 && /context|too long|maximum.*tokens/i.test(m))
    return new ModelError('context_too_long', 'The request is too long for this model', s);
  if (s >= 400 && s < 500) return new ModelError('bad_request', m, s);
  return new ModelError('unavailable', m, s || null);
}
