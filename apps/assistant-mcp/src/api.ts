/** The adapter uses the authenticated application API, never its database. */
export class AuthoringApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) { super('Junction26 request failed'); this.status = status; this.body = body; }
}

export interface AuthoringBackend {
  request(path: string, options?: { body?: unknown; operationId?: string; signal?: AbortSignal }): Promise<Record<string, unknown>>;
}

export class AuthoringApi implements AuthoringBackend {
  private readonly origin: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(origin: string, token: string, fetcher: typeof fetch = fetch) {
    const url = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('JUNCTION26_API_ORIGIN must be an origin without credentials, path or query');
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Junction26 requires HTTPS except on loopback');
    if (!token || /\s/.test(token) || token.startsWith('j26d_')) throw new Error('Set JUNCTION26_AUTHORING_TOKEN to an authoring session, not a device token');
    if (token.startsWith('dev:') && !local) throw new Error('Development credentials may only be used with a loopback API');
    this.origin = url.origin;
    this.token = token;
    this.fetcher = fetcher;
  }

  async request(path: string, options: { body?: unknown; operationId?: string; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.operationId) headers['idempotency-key'] = options.operationId;
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}/v1/${path}`, {
        method: options.body === undefined ? 'GET' : 'POST', headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        redirect: 'error',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AuthoringApiError(503, { error: { code: 'api_unavailable', message: 'Junction26 could not be reached. Retry writes with the same operationId and content.' } });
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new AuthoringApiError(response.status, body ?? { error: { code: 'api_error', message: 'Junction26 rejected the request' } });
    if (!body) throw new AuthoringApiError(502, { error: { code: 'invalid_api_response', message: 'Junction26 returned an invalid response' } });
    return body;
  }
}
