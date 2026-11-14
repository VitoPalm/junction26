import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { ModelError, type CompletionRequest, type CompletionResult, type ModelProvider } from './types.ts';

/**
 * Model specs are "provider:model", e.g. "openrouter:openai/gpt-6-luna" or
 * "fake:demo". A bare name (no known provider prefix) means OpenRouter, so the
 * existing AUTHORING_MODEL=openai/gpt-6-luna keeps working.
 */
export interface ModelSpec {
  provider: string;
  model: string;
  /** Canonical "provider:model". */
  id: string;
}

export function parseModelSpec(spec: string, knownProviders: Iterable<string> = ['openrouter', 'openai', 'fake']): ModelSpec {
  const s = spec.trim();
  const i = s.indexOf(':');
  const known = new Set(knownProviders);
  if (i > 0 && known.has(s.slice(0, i))) {
    const provider = s.slice(0, i);
    const model = s.slice(i + 1);
    return { provider, model, id: `${provider}:${model}` };
  }
  return { provider: 'openrouter', model: s, id: `openrouter:${s}` };
}

/** Deterministic, free provider for local development, demos without credit, and tests. */
export class FakeProvider implements ModelProvider {
  readonly id = 'fake';
  readonly calls: CompletionRequest[] = [];
  private readonly respond: (req: CompletionRequest, call: number) => string | Promise<string>;
  constructor(respond: (req: CompletionRequest, call: number) => string | Promise<string>) {
    this.respond = respond;
  }
  capabilities() {
    return { images: true, files: true, structuredOutput: true };
  }
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    req.signal?.throwIfAborted();
    this.calls.push(req);
    const text = await this.respond(req, this.calls.length);
    return {
      text,
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
  openAI?: { apiKey: string | undefined; baseUrl: string };
  fake?: (req: CompletionRequest, call: number) => string | Promise<string>;
}

export class ModelRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  register(p: ModelProvider): this {
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
  if (config.fake) r.register(new FakeProvider(config.fake));
  return r;
}
