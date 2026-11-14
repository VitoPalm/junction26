/**
 * Provider-neutral model interface. The worker only talks to `ModelProvider`;
 * OpenRouter (today: openai/gpt-6-luna) is one implementation. Adding a
 * protocol means implementing `ModelProvider`; native Anthropic/Gemini and
 * configurable compatible endpoints are included.
 */

export type Part =
  | { type: 'text'; text: string }
  /** Base64 without a data: prefix. */
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'file'; mediaType: string; filename: string; data: string }
  /** Base64 audio clip (e.g. a voice command). Sent as OpenAI/OpenRouter `input_audio`. */
  | { type: 'audio'; format: 'wav' | 'mp3'; data: string };

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  /** Opaque adapter-owned assistant state (e.g. Gemini thought signatures). */
  providerState?: { provider: string; content: unknown[] };
  toolCallId?: string;
  toolCalls?: ToolCall[];
  content: Part[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface ModelTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  tools?: ModelTool[];
  /** "required": the model must call one of `tools` (no plain-text answer). Default: provider's "auto". */
  toolChoice?: 'auto' | 'required';
  /** Bounded OpenRouter server search, executed separately from final JSON authoring. */
  webSearch?: boolean;
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
  providerState?: ChatMessage['providerState'];
  toolCalls?: ToolCall[];
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
  /** Audio clips as input (`audio` parts). */
  audio: boolean;
  structuredOutput: boolean;
  /** Function tools; omitted by older custom adapters means supported. */
  tools?: boolean;
  webSearch?: boolean;
}

export interface ModelProvider {
  /** Registry key, e.g. "openrouter". */
  readonly id: string;
  /** Local configuration only; does not imply a verified key or provider access. */
  readonly configured?: boolean;
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
