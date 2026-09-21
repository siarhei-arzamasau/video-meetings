import type http from 'node:http';
import type { AddressInfo } from 'node:net';

import type request from 'supertest';

/**
 * The port of the suite's server, binding it to an ephemeral one first if need be — for a
 * client that speaks `node:http` directly. `useApiSuite` binds it before the first test, so
 * supertest never binds and closes it per request; the bind here covers a caller outside that
 * suite. `app.close()` in the suite's `afterAll` closes it again.
 */
export async function listeningPort(server: http.Server): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
  }

  return (server.address() as AddressInfo).port;
}

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
