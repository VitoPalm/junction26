import { postJson, schemaPrompt, validateRequest, type HttpOptions } from './http.ts';
import { ModelError, type CompletionRequest, type CompletionResult, type ModelCapabilities, type ModelProvider, type Part } from './types.ts';

export interface AnthropicOptions extends HttpOptions {
  id?: string;
}

/** Native Messages API. Schema guidance avoids requiring a provider-specific subset of our applet schema. */
export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly o: AnthropicOptions;
  constructor(o: AnthropicOptions) { this.o = o; this.id = o.id ?? 'anthropic'; }
  get configured(): boolean { return Boolean(this.o.apiKey); }
  capabilities(): ModelCapabilities { return { images: true, files: true, audio: false, structuredOutput: false, tools: true, webSearch: false }; }
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.o.apiKey) throw new ModelError('not_configured', 'No API key for Anthropic');
    validateRequest(req, this.capabilities());
    if (req.webSearch) throw new ModelError('bad_request', 'Server search is not configured for Anthropic');
    const messages: { role: string; content: unknown[] }[] = [];
    for (const m of req.messages) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content = m.role === 'tool'
        ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content.map(toWire) }]
        : [...m.content.map(toWire), ...(m.toolCalls ?? []).map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: JSON.parse(t.arguments) }))];
      const previous = messages.at(-1);
      if (previous?.role === role) previous.content.push(...content);
      else messages.push({ role, content });
    }
    const json = await postJson(this.o, req, 'messages', { 'x-api-key': this.o.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: req.model, system: schemaPrompt(req), max_tokens: req.maxOutputTokens, messages,
      ...(req.tools?.length ? {
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        tool_choice: { type: req.toolChoice === 'required' ? 'any' : 'auto' },
      } : {}),
    });
    if (!Array.isArray(json.content)) throw new ModelError('invalid_response', 'Anthropic returned no content');
    return {
      text: json.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(''),
      toolCalls: json.content.filter((p: any) => p.type === 'tool_use').map((p: any) => ({ id: p.id, name: p.name, arguments: JSON.stringify(p.input) })),
      finishReason: json.stop_reason === 'max_tokens' ? 'length' : json.stop_reason === 'refusal' ? 'content_filter' : ['end_turn', 'tool_use', 'stop_sequence'].includes(json.stop_reason) ? 'stop' : 'other',
      usage: { inputTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.cache_creation_input_tokens ?? 0) + (json.usage?.cache_read_input_tokens ?? 0), outputTokens: json.usage?.output_tokens ?? 0, costUsd: null },
      provider: this.id, model: json.model ?? req.model, requestId: json.id ?? null,
    };
  }
}

function toWire(p: Part): unknown {
  if (p.type === 'text') return p;
  if (p.type === 'image') return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } };
  if (p.type === 'file' && p.mediaType === 'application/pdf') return { type: 'document', title: p.filename, source: { type: 'base64', media_type: p.mediaType, data: p.data } };
  throw new ModelError('bad_request', 'Anthropic input supports text, images and PDF documents; audio is unsupported');
}
