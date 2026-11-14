import {
  ModelError,
  type CompletionRequest,
  type CompletionResult,
  type ModelCapabilities,
  type ModelProvider,
  type Part,
} from './types.ts';
import { postJson, schemaPrompt, validateRequest } from './http.ts';

export interface OpenAICompatibleOptions {
  /** Registry key ("openrouter", or e.g. "openai", "local"). */
  id: string;
  baseUrl: string;
  apiKey: string | undefined;
  /** Enables OpenRouter-only request fields (provider routing, usage accounting). */
  openRouter?: boolean;
  /** Explicitly allow endpoints without credentials (local servers only, by operator choice). */
  auth?: 'bearer' | 'none';
  responseFormat?: 'json_schema' | 'json_object' | 'prompt';
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
  capabilities?: Partial<ModelCapabilities>;
  modelCapabilities?: Record<string, Partial<ModelCapabilities>>;
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

  get configured(): boolean { return this.o.auth === 'none' || Boolean(this.o.apiKey); }

  capabilities(model: string): ModelCapabilities {
    // Conservative defaults; refine per model as they're tested.
    const vision = /gpt|claude|gemini|luna|vision|vl|llava|qwen.*vl/i.test(model);
    // Models OpenRouter lists with audio input (checked 2026-11-14); unknown models say no.
    const audio = /gemini|gpt-audio|gpt-4o-audio|omni|mimo|voxtral/i.test(model);
    return { images: vision, files: this.o.openRouter === true, audio, structuredOutput: true,
      tools: true, webSearch: this.o.openRouter === true, ...this.o.capabilities, ...this.o.modelCapabilities?.[model] };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.o.auth !== 'none' && !this.o.apiKey) throw new ModelError('not_configured', `No API key for model provider "${this.id}"`);
    const caps = this.capabilities(req.model);
    validateRequest(req, caps);
    const format = caps.structuredOutput ? this.o.responseFormat ?? 'json_schema' : 'prompt';
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: 'system', content: format === 'prompt' || format === 'json_object' ? schemaPrompt(req) : req.system },
        ...req.messages.map((m) => ({
          role: m.role,
          content:
            m.role === 'tool'
              ? m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
              : m.content.every((p) => p.type === 'text')
                ? m.content.map((p) => p.type === 'text' ? p.text : '').join('\n') || (m.toolCalls?.length ? null : '')
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
      [this.o.tokenParameter ?? 'max_tokens']: req.maxOutputTokens,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
      if (req.toolChoice) body.tool_choice = req.toolChoice;
    }
    if (req.webSearch && !this.o.openRouter) throw new ModelError('bad_request', 'Web search requires OpenRouter');
    if (req.responseSchema && format !== 'prompt') {
      body.response_format = format === 'json_object' ? { type: 'json_object' } : {
        type: 'json_schema',
        // Not strict: OpenAI strict mode forbids optional properties, which the
        // applet format relies on. We validate locally either way.
        json_schema: { name: req.responseSchema.name, strict: false, schema: req.responseSchema.schema },
      };
    }
    if (req.reasoningEffort && this.o.openRouter) body.reasoning = { effort: req.reasoningEffort };
    else if (req.reasoningEffort && this.id === 'openai') body.reasoning_effort = req.reasoningEffort;
    if (this.o.openRouter) {
      body.usage = { include: true };
      // Only route to endpoints that honour response_format; don't silently fall back to another model.
      body.provider = { require_parameters: true, allow_fallbacks: false };
    }

    if (req.webSearch) {
      delete body.messages;
      delete body.max_tokens;
      delete body.max_completion_tokens;
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
    const json = await postJson(this.o, req, req.webSearch ? 'responses' : 'chat/completions', {
      ...(this.o.apiKey && this.o.auth !== 'none' ? { authorization: `Bearer ${this.o.apiKey}` } : {}), ...this.o.headers,
    }, body);
    if (!req.webSearch && !json.choices?.[0]?.message)
      throw new ModelError('invalid_response', 'The provider returned no completion');
    if (req.webSearch && !Array.isArray(json.output))
      throw new ModelError('invalid_response', 'The provider returned no search output');

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
    case 'audio':
      return { type: 'input_audio', input_audio: { data: p.data, format: p.format } };
  }
}
