import { Logger } from '@nestjs/common';

import { useApiSuite } from './utils/api-suite';
import { EMAIL, MEETINGS_URL, meetingFileEventsUrl } from './utils/fixtures';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { openSse } from './utils/sse';

/** How long a line may trail its response: it is written when the connection reports `close`. */
const LINE_WAIT_MS = 2_000;

const linesOf = (spy: jest.SpyInstance, url: string): string[] =>
  spy.mock.calls
    .map(([message]: unknown[]) => String(message))
    .filter((message) => message.includes(` ${url} `));

/** The one line written for `url`, waited for: the response reaches the client first. */
const lineOf = async (
  spy: jest.SpyInstance,
  url: string,
  deadline = Date.now() + LINE_WAIT_MS,
): Promise<string> => {
  const lines = linesOf(spy, url);

  if (lines.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));

    return lineOf(spy, url, deadline);
  }

  expect(lines).toHaveLength(1);

  return lines[0] ?? '';
};

/**
 * One line per request, whoever answered it.
 *
 * The line used to be an interceptor's, and an interceptor sees only what reaches a handler,
 * once per value the handler answers with: a request a guard refused left nothing, and a files
 * stream left a line for every event it sent. The suite runs with Nest's logger off, so the
 * lines are read from `Logger` itself, where they are written whether or not anything prints.
 */
describe('the request log', () => {
  const suite = useApiSuite();
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log');
    warn = jest.spyOn(Logger.prototype, 'warn');
  });

  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
  });

  it('logs a request that was answered, once', async () => {
    await suite.get('/api/health').expect(200);

    await expect(lineOf(log, '/api/health')).resolves.toMatch(/^GET \/api\/health 200 \d+ms$/);
    expect(linesOf(warn, '/api/health')).toEqual([]);
  });

  it('logs a request the guard refused, as a warning', async () => {
    await suite.get(MEETINGS_URL).expect(401);

    await expect(lineOf(warn, MEETINGS_URL)).resolves.toMatch(/^GET \/api\/meetings 401 \d+ms$/);
    expect(linesOf(log, MEETINGS_URL)).toEqual([]);
  });

  it('logs a path no route answers, as a warning', async () => {
    await suite.get('/api/nowhere').expect(404);

    await expect(lineOf(warn, '/api/nowhere')).resolves.toMatch(/^GET \/api\/nowhere 404 \d+ms$/);
  });

  it('logs a stream once, when it ends, however much it sent', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const url = meetingFileEventsUrl(meeting.id);
    const client = await openSse(suite, url, host.token);

    // The stream has answered and sent an event, and it is still open: nothing is logged yet.
    await client.nextOf('ping');
    expect(linesOf(log, url)).toEqual([]);

    client.close();

    await expect(lineOf(log, url)).resolves.toMatch(/ 200 \(closed by the client\) \d+ms$/);
    expect(linesOf(warn, url)).toEqual([]);
  });
});
