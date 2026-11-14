/**
 * Provider-neutral model interface. The worker only talks to `ModelProvider`;
 * OpenRouter (today: openai/gpt-6-luna) is one implementation. Adding a
 * provider (direct Anthropic, Gemini, a local model, a BYO key) means writing
 * one `ModelProvider` and registering it in registry.ts. Nothing else changes.
 */

export type Part =
  | { type: 'text'; text: string }
  /** Base64 without a data: prefix. */
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'file'; mediaType: string; filename: string; data: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: Part[];
}

export interface CompletionRequest {
  /** Provider-specific model name (the part after "provider:" in a model spec). */
  model: string;
  system: string;
  messages: ChatMessage[];
  /** Ask for JSON matching this schema. Providers that can't enforce it still get it as guidance. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** USD, when the provider reports it. */
  costUsd: number | null;
}

export interface CompletionResult {
  text: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'other';
  usage: Usage;
  /** What actually answered (providers may route). */
  provider: string;
  model: string;
  requestId: string | null;
}

export interface ModelCapabilities {
  images: boolean;
  /** PDFs passed as files. */
  files: boolean;
  structuredOutput: boolean;
}

export interface ModelProvider {
  /** Registry key, e.g. "openrouter". */
  readonly id: string;
  capabilities(model: string): ModelCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export type ModelErrorCode =
  | 'not_configured'
  | 'auth'
  | 'insufficient_credits'
  | 'rate_limited'
  | 'context_too_long'
  | 'bad_request'
  | 'unavailable'
  | 'timeout'
  | 'invalid_response';

const RETRYABLE: ReadonlySet<ModelErrorCode> = new Set(['rate_limited', 'unavailable', 'timeout']);

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(code: ModelErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.status = status;
    this.retryable = RETRYABLE.has(code);
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: null };
