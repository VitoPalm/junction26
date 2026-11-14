import { ModelError, type CompletionRequest } from './types.ts';

export interface HttpOptions {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Shared transport: includes body reads in the timeout and never exposes provider payloads/secrets in errors. */
export async function postJson(o: HttpOptions, req: CompletionRequest, path: string, headers: Record<string, string>, body: unknown): Promise<any> {
  req.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 180_000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  try {
    const res = await (o.fetch ?? fetch)(`${o.baseUrl.replace(/\/+$/, '')}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal,
    });
    const raw = await res.text();
    let json: any;
    try { json = JSON.parse(raw); } catch {
      if (!res.ok) throw statusError(res.status);
      throw new ModelError('invalid_response', 'The model provider returned non-JSON');
    }
    if (!res.ok || json?.error) throw statusError(res.ok ? Number(json.error?.code) || 503 : res.status, json?.error);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ModelError('invalid_response', 'The model provider returned an invalid response');
    return json;
  } catch (e) {
    if (req.signal?.aborted) throw req.signal.reason;
    if (timeout.aborted) throw new ModelError('timeout', 'The model took too long to answer');
    if (e instanceof ModelError) throw e;
    throw new ModelError('unavailable', 'Could not reach the model provider');
  }
}

export function statusError(status: number, error?: any): ModelError {
  const detail = `${error?.type ?? ''} ${error?.code ?? ''} ${error?.message ?? ''}`;
  if (status === 401 || status === 403) return new ModelError('auth', 'The model provider refused the credentials', status);
  if (status === 402 || /insufficient_quota|credit.*balance|insufficient.*credit/i.test(detail)) return new ModelError('insufficient_credits', 'The model provider budget is used up', status);
  if (status === 429) return new ModelError('rate_limited', 'The model provider is rate limiting us', status);
  if (status === 408 || status === 504) return new ModelError('timeout', 'The model took too long to answer', status);
  if ((status === 400 || status === 413) && /context|too long|maximum.*tokens|token.*limit/i.test(detail)) return new ModelError('context_too_long', 'The request is too long for this model', status);
  if (status >= 400 && status < 500) return new ModelError('bad_request', 'The model provider rejected the request; check model capabilities and configuration', status);
  return new ModelError('unavailable', 'The model provider is unavailable', status);
}

/** Complex applet schemas remain locally validated; prompt mode works with providers with limited JSON Schema support. */
export function schemaPrompt(req: CompletionRequest): string {
  return req.system + (req.responseSchema ? `\nReturn only JSON matching this schema when answering (tool calls may precede the final answer):\n${JSON.stringify(req.responseSchema.schema)}` : '');
}

export function validateRequest(req: CompletionRequest, caps: import('./types.ts').ModelCapabilities): void {
  if (req.tools?.length && caps.tools === false) throw new ModelError('bad_request', 'This model is configured without function tools');
  for (const message of req.messages) for (const part of message.content) {
    if ((part.type === 'image' && !caps.images) || (part.type === 'file' && !caps.files) || (part.type === 'audio' && !caps.audio))
      throw new ModelError('bad_request', `This model is configured without ${part.type} input`);
  }
}
