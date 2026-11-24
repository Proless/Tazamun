import type { schema } from '@tazamun/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * An expected API error (SRS 4.4.1). Thrown from handlers and turned into
 * `{"error": {"code", "message", "retryAfter"?}}` by the app's error handler. Messages are shown
 * to users by clients, so they say what happened, and never contain request data.
 */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: schema.ErrorCode;
  readonly retryAfter: number | undefined;

  constructor(
    status: ContentfulStatusCode,
    code: schema.ErrorCode,
    message: string,
    retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const unauthorized = (): ApiError =>
  new ApiError(401, 'UNAUTHORIZED', 'Not signed in, or the session has ended. Sign in again.');

export const invalidCredentials = (): ApiError =>
  new ApiError(401, 'INVALID_CREDENTIALS', 'The account ID or passphrase is wrong.');

export const notFound = (what: string): ApiError =>
  new ApiError(404, 'NOT_FOUND', `${what} not found.`);
