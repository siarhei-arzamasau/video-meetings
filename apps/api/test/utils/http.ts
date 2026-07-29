import type request from 'supertest';

/**
 * Asserts the success contract — a body of exactly `{ accessToken }` holding something
 * shaped like a JWT — and unwraps the token.
 */
export function accessTokenOf(response: request.Response): string {
  const body = response.body as { accessToken?: unknown };
  const { accessToken } = body;

  if (typeof accessToken !== 'string') {
    throw new Error(`Expected an accessToken string, received ${JSON.stringify(response.body)}`);
  }

  // A non-empty string is too weak a bar: "x" would pass. Require the wire shape.
  if (accessToken.split('.').length !== 3) {
    throw new Error(`Expected a three-segment JWT, received ${JSON.stringify(accessToken)}`);
  }

  return accessToken;
}

/** The error message from `HttpExceptionFilter`'s response shape. */
export function messageOf(response: request.Response): string | string[] {
  const body = response.body as { message?: string | string[] };

  if (body.message === undefined) {
    throw new Error(`Expected an error message, received ${JSON.stringify(response.body)}`);
  }

  return body.message;
}
