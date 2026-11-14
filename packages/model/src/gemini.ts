import { postJson, schemaPrompt, validateRequest, type HttpOptions } from './http.ts';
import { ModelError, type CompletionRequest, type CompletionResult, type ModelCapabilities, type ModelProvider, type Part } from './types.ts';

export interface GeminiOptions extends HttpOptions { id?: string; }

/** Native generateContent API; preserves complete model parts so thought signatures survive tool turns. */
export class GeminiProvider implements ModelProvider {
  readonly id: string;
  private readonly o: GeminiOptions;
  constructor(o: GeminiOptions) { this.o = o; this.id = o.id ?? 'gemini'; }
  get configured(): boolean { return Boolean(this.o.apiKey); }
  capabilities(): ModelCapabilities { return { images: true, files: true, audio: true, structuredOutput: false, tools: true, webSearch: false }; }
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.o.apiKey) throw new ModelError('not_configured', 'No API key for Gemini');
    validateRequest(req, this.capabilities());
    if (req.webSearch) throw new ModelError('bad_request', 'Server search is not configured for Gemini');
    const calls = new Map(req.messages.flatMap((m) => (m.toolCalls ?? []).map((t) => [t.id, { ...t, nativeId: m.providerState?.content.find((p: any) => p.functionCall?.id === t.id) ? t.id : undefined }] as const)));
    const contents: { role: string; parts: unknown[] }[] = [];
    for (const m of req.messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      let parts: unknown[];
      if (m.role === 'tool') {
        const call = calls.get(m.toolCallId ?? '');
        if (!call) throw new ModelError('bad_request', 'Gemini tool result has no matching function call');
        parts = [{ functionResponse: { ...(call.nativeId ? { id: call.nativeId } : {}), name: call.name, response: { result: m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') } } }];
      } else if (m.role === 'assistant' && m.providerState?.provider === this.id) {
        parts = m.providerState.content;
      } else {
        parts = [...m.content.map(toWire), ...(m.toolCalls ?? []).map((t) => ({ functionCall: { name: t.name, args: JSON.parse(t.arguments) } }))];
      }
      const previous = contents.at(-1);
      if (previous?.role === role) previous.parts.push(...parts);
      else contents.push({ role, parts });
    }
    const json = await postJson(this.o, req, `models/${encodeURIComponent(req.model.replace(/^models\//, ''))}:generateContent`, { 'x-goog-api-key': this.o.apiKey }, {
      systemInstruction: { parts: [{ text: schemaPrompt(req) }] }, contents,
      generationConfig: { maxOutputTokens: req.maxOutputTokens },
      ...(req.tools?.length ? {
        tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
        toolConfig: { functionCallingConfig: { mode: req.toolChoice === 'required' ? 'ANY' : 'AUTO' } },
      } : {}),
    });
    const candidate = json.candidates?.[0];
    const blocked = Boolean(json.promptFeedback?.blockReason) || ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(candidate?.finishReason);
    if (!candidate && !blocked) throw new ModelError('invalid_response', 'Gemini returned no candidate');
    const parts = candidate?.content?.parts ?? [];
    return {
      text: parts.filter((p: any) => typeof p.text === 'string' && !p.thought).map((p: any) => p.text).join(''),
      toolCalls: parts.flatMap((p: any, i: number) => p.functionCall ? [{ id: p.functionCall.id ?? `gemini-${json.responseId ?? crypto.randomUUID()}-${i}`, name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) }] : []),
      providerState: { provider: this.id, content: parts },
      finishReason: blocked ? 'content_filter' : candidate?.finishReason === 'MAX_TOKENS' ? 'length' : candidate?.finishReason === 'STOP' ? 'stop' : 'other',
      usage: { inputTokens: json.usageMetadata?.promptTokenCount ?? 0, outputTokens: (json.usageMetadata?.candidatesTokenCount ?? 0) + (json.usageMetadata?.thoughtsTokenCount ?? 0), costUsd: null },
      provider: this.id, model: json.modelVersion ?? req.model, requestId: json.responseId ?? null,
    };
  }
}

function toWire(p: Part): unknown {
  if (p.type === 'text') return { text: p.text };
  return { inlineData: { mimeType: p.type === 'audio' ? (p.format === 'mp3' ? 'audio/mpeg' : 'audio/wav') : p.mediaType, data: p.data } };
}
