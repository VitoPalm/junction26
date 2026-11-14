import { AnthropicProvider, type AnthropicOptions } from './anthropic.ts';
import { GeminiProvider, type GeminiOptions } from './gemini.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openai-compatible.ts';
import { ModelError, type CompletionRequest, type CompletionResult, type ModelProvider, type ToolCall } from './types.ts';

/**
 * Model specs are "provider:model", e.g. "openrouter:openai/gpt-6-luna" or
 * "fake:demo". A bare name means OpenRouter, so the
 * existing AUTHORING_MODEL=openai/gpt-6-luna keeps working.
 */
export interface ModelSpec {
  provider: string;
  model: string;
  /** Canonical "provider:model". */
  id: string;
}

export function parseModelSpec(spec: string, knownProviders: Iterable<string> = ['openrouter', 'openai', 'anthropic', 'gemini', 'fake']): ModelSpec {
  const s = spec.trim();
  const i = s.indexOf(':');
  const known = new Set(knownProviders);
  if (!s || (i === s.length - 1)) throw new ModelError('bad_request', 'A model spec must include a model name');
  if (i > 0 && (known.has(s.slice(0, i)) || /^[a-z][a-z0-9_-]*$/.test(s.slice(0, i)))) {
    const provider = s.slice(0, i);
    const model = s.slice(i + 1);
    return { provider, model, id: `${provider}:${model}` };
  }
  return { provider: 'openrouter', model: s, id: `openrouter:${s}` };
}

/** A fake reply: plain text, or text plus tool calls. */
export type FakeResponder = (req: CompletionRequest, call: number) => FakeReply | Promise<FakeReply>;
export type FakeReply = string | { text?: string; toolCalls?: ToolCall[] };

/** Deterministic, free provider for local development, demos without credit, and tests. */
export class FakeProvider implements ModelProvider {
  readonly id = 'fake';
  readonly calls: CompletionRequest[] = [];
  private readonly respond: FakeResponder;
  constructor(respond: FakeResponder) {
    this.respond = respond;
  }
  capabilities() {
    return { images: true, files: true, audio: true, structuredOutput: true };
  }
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    req.signal?.throwIfAborted();
    this.calls.push(req);
    const out = await this.respond(req, this.calls.length);
    const text = typeof out === 'string' ? out : (out.text ?? '');
    return {
      text,
      ...(typeof out === 'string' || !out.toolCalls ? {} : { toolCalls: out.toolCalls }),
      finishReason: 'stop',
      usage: { inputTokens: Math.ceil(req.system.length / 4), outputTokens: Math.ceil(text.length / 4), costUsd: 0 },
      provider: 'fake',
      model: req.model,
      requestId: `fake-${this.calls.length}`,
    };
  }
}

export interface ProviderConfig {
  openRouter?: { apiKey: string | undefined; baseUrl: string };
  /** Any OpenAI-compatible endpoint (OpenAI, a local vLLM/Ollama...). */
  openAI?: Omit<OpenAICompatibleOptions, 'id'>;
  anthropic?: AnthropicOptions;
  gemini?: GeminiOptions;
  compatible?: OpenAICompatibleOptions[];
  fake?: FakeResponder;
}

export class ModelRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  register(p: ModelProvider): this {
    if (this.providers.has(p.id)) throw new ModelError('bad_request', `Duplicate model provider: ${p.id}`);
    this.providers.set(p.id, p);
    return this;
  }
  has(id: string): boolean {
    return this.providers.has(id);
  }
  ids(): string[] {
    return [...this.providers.keys()];
  }
  resolve(spec: string | ModelSpec): { provider: ModelProvider; spec: ModelSpec } {
    const s = typeof spec === 'string' ? parseModelSpec(spec, this.providers.keys()) : spec;
    const provider = this.providers.get(s.provider);
    if (!provider) throw new ModelError('not_configured', `Model provider "${s.provider}" is not configured`);
    return { provider, spec: s };
  }
}

export function createModelRegistry(config: ProviderConfig): ModelRegistry {
  const r = new ModelRegistry();
  if (config.openRouter) {
    r.register(
      new OpenAICompatibleProvider({
        id: 'openrouter',
        ...config.openRouter,
        openRouter: true,
        headers: { 'X-Title': 'Junction26 applets' },
      }),
    );
  }
  if (config.openAI) r.register(new OpenAICompatibleProvider({ id: 'openai', ...config.openAI }));
  if (config.anthropic) r.register(new AnthropicProvider(config.anthropic));
  if (config.gemini) r.register(new GeminiProvider(config.gemini));
  for (const provider of config.compatible ?? []) r.register(new OpenAICompatibleProvider(provider));
  if (config.fake) r.register(new FakeProvider(config.fake));
  return r;
}

/** Structural config contract shared by API metadata, voice and worker. Secrets never leave the server. */
export function registryFromSettings(settings: {
  apiKey: string | undefined; baseUrl: string; openAI: ProviderConfig['openAI'];
  anthropic?: AnthropicOptions; gemini?: GeminiOptions; compatible?: OpenAICompatibleOptions[];
}, fake?: FakeResponder): ModelRegistry {
  return createModelRegistry({ openRouter: { apiKey: settings.apiKey, baseUrl: settings.baseUrl },
    openAI: settings.openAI, anthropic: settings.anthropic, gemini: settings.gemini, compatible: settings.compatible, fake });
}
