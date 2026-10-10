import http from 'node:http';

import type { DigestHolds } from './digest-holds';

/** Loopback only, beside the suite's other three: web 3100, API 3101, fake Whisper 3102. */
export const CONTROL_HOST = '127.0.0.1';
export const CONTROL_PORT = 3103;

const HOLDS_PATH = '/control/holds';
const SETTING_PATH = '/control/setting';
const CATCH_UP_PATH = '/control/catch-up';

/** What the control port can reach in the API it belongs to. */
export interface ControlTargets {
  holds: DigestHolds;
  /** Switches `MEETING_DIGEST_ENABLED` in the running application. */
  setDigestEnabled(enabled: boolean): void;
  /** Runs the digest's boot catch-up in the running application, to its end. */
  catchUpDigests(): Promise<number>;
}

/** `POST /control/catch-up`: answered once every digest that was owed has been asked for. */
async function handleCatchUp({ catchUpDigests }: ControlTargets, method: string): Promise<number> {
  if (method !== 'POST') {
    return 404;
  }

  await catchUpDigests();

  return 204;
}

/** `PUT /control/setting/on` and `/off`: the deployment's setting, without the restart. */
function handleSetting({ setDigestEnabled }: ControlTargets, method: string, path: string): number {
  const value = path.slice(SETTING_PATH.length + 1);

  if (method !== 'PUT' || (value !== 'on' && value !== 'off')) {
    return 404;
  }

  setDigestEnabled(value === 'on');

  return 204;
}

function handleHolds({ holds }: ControlTargets, method: string, path: string): number {
  const key = path.startsWith(`${HOLDS_PATH}/`)
    ? decodeURIComponent(path.slice(HOLDS_PATH.length + 1))
    : null;

  if (method === 'PUT' && key !== null && key !== '') {
    holds.hold(key);
  } else if (method === 'DELETE' && key !== null && key !== '') {
    holds.release(key);
  } else if (method === 'DELETE' && path === HOLDS_PATH) {
    holds.releaseAll();
  } else {
    return 404;
  }

  return 204;
}

/**
 * How a browser spec reaches the scripted Claude, which lives in another process: a second,
 * loopback-only listener in the API the suite starts. Not a route of the application — that
 * would be a test seam in production code, behind its guards and its prefix.
 *
 * | Request                        | Does                                                  |
 * | ------------------------------ | ----------------------------------------------------- |
 * | `PUT /control/holds/:key`      | Holds the key: a generation naming it waits, or fails |
 * | `DELETE /control/holds/:key`   | Releases that key, and whatever waited on it          |
 * | `DELETE /control/holds`        | Releases every key: what a test does at its end       |
 * | `PUT /control/setting/off`     | Switches the meeting digest off, as a deployment can  |
 * | `PUT /control/setting/on`      | Switches it back on, which is how this API boots      |
 * | `POST /control/catch-up`       | Asks for every digest that is owed, as a boot does    |
 *
 * **The setting is switched here because a spec cannot restart the API.** A recording
 * "transcribed while the feature was off" is the state the boot's catch-up exists for, and
 * the only other way to reach it is a second server. It is safe to switch in this process
 * and no other: what the setting gates here is the scripted Claude, never Anthropic. Nothing
 * is announced when it changes — a real change is a restart, which ends every stream — so a
 * spec opens its pages after switching.
 *
 * **Switching it on is not the restart, and the catch-up is a request of its own for that.**
 * In a deployment the setting comes back with a boot, and the boot catches up. Here
 * `claude.reset()` switches it on around every test, over a database the specs share: a
 * catch-up tied to the switch would generate, before each test, for whatever every earlier
 * one left owed. So the one spec that means "and then the API was restarted" says so.
 */
async function handle(targets: ControlTargets, request: http.IncomingMessage): Promise<number> {
  const path = request.url ?? '';
  const method = request.method ?? '';

  if (path === CATCH_UP_PATH) {
    return handleCatchUp(targets, method);
  }

  return path.startsWith(`${SETTING_PATH}/`)
    ? handleSetting(targets, method, path)
    : handleHolds(targets, method, path);
}

/** Resolves once the control port is listening, so the API never answers before it does. */
export function listenForControl(targets: ControlTargets): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    void handle(targets, request).then(
      (status) => response.writeHead(status).end(),
      // Nothing behind this port rejects; if something comes to, the spec is told so.
      () => response.writeHead(500).end(),
    );
  });

  // Not a reason to stay alive: when the application closes, the process is done.
  server.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(CONTROL_PORT, CONTROL_HOST, () => resolve(server));
  });
}
