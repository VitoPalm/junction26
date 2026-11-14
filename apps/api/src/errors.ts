import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Every error response has the shape `{ "error": { code, message, details? } }`.
 * `code` is stable and machine-readable; `message` is for people. The full
 * catalog is in docs/api.md ("Errors").
 */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'invalid_request', message, details);
export const forbidden = (message: string) => new ApiError(403, 'forbidden', message);
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
