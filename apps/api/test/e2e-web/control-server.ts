import http from 'node:http';

import type { DigestHolds } from './digest-holds';

/** Loopback only, beside the suite's other three: web 3100, API 3101, fake Whisper 3102. */
export const CONTROL_HOST = '127.0.0.1';
export const CONTROL_PORT = 3103;

const HOLDS_PATH = '/control/holds';

/**
 * How a browser spec reaches the scripted Claude, which lives in another process: a second,
 * loopback-only listener in the API the suite starts. Not a route of the application — that
 * would be a test seam in production code, behind its guards and its prefix.
 *
 * | Request                        | Does                                             |
 * | ------------------------------ | ------------------------------------------------ |
 * | `PUT /control/holds/:key`      | Holds every generation whose transcripts name it |
 * | `DELETE /control/holds/:key`   | Releases that key, and whatever waited on it     |
 * | `DELETE /control/holds`        | Releases every key: what a test does at its end  |
 */
function handle(holds: DigestHolds, request: http.IncomingMessage): number {
  const path = request.url ?? '';
  const key = path.startsWith(`${HOLDS_PATH}/`)
    ? decodeURIComponent(path.slice(HOLDS_PATH.length + 1))
    : null;

  if (request.method === 'PUT' && key !== null && key !== '') {
    holds.hold(key);
  } else if (request.method === 'DELETE' && key !== null && key !== '') {
    holds.release(key);
  } else if (request.method === 'DELETE' && path === HOLDS_PATH) {
    holds.releaseAll();
  } else {
    return 404;
  }

  return 204;
}

/** Resolves once the control port is listening, so the API never answers before it does. */
export function listenForControl(holds: DigestHolds): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    response.writeHead(handle(holds, request)).end();
  });

  // Not a reason to stay alive: when the application closes, the process is done.
  server.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(CONTROL_PORT, CONTROL_HOST, () => resolve(server));
  });
}
