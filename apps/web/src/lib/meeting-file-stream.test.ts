import type { MeetingFile } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DROP_WINDOW_MS,
  MAX_STREAM_DROPS,
  RECONNECT_DELAYS_MS,
  watchMeetingFiles,
} from './meeting-file-stream';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const FILE: MeetingFile = {
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'deck.pdf',
  contentType: 'application/pdf',
  size: 10,
  status: 'ready',
  createdAt: '2026-09-01T10:00:00.000Z',
};

const PROCESSING: MeetingFile = { ...FILE, id: 'f2', status: 'processing' };

const fileEvent = (file: MeetingFile): string => `event: file\ndata: ${JSON.stringify(file)}\n\n`;

/** A `Response` whose body is this text, typed as an event stream. */
const stream = (text: string): Response =>
  new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface Harness {
  /** Runs the watch to completion. Every reconnect is instant; the waits are recorded. */
  run(): Promise<void>;
  waits: number[];
  files: MeetingFile[];
  /** Every `onOpen` and `onFile`, in the order they were called. */
  calls: string[];
  onOpen: ReturnType<typeof vi.fn>;
  onUnauthorized: ReturnType<typeof vi.fn>;
  onUnavailable: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  controller: AbortController;
}

/**
 * A watch over a scripted `fetch`: one entry per connection, the last one repeating.
 *
 * `stopAfter` aborts once that many reconnect waits have happened, which is what ends a test
 * whose script never stops producing streams. The waits themselves are recorded, not taken,
 * so nothing here depends on a timer.
 */
function harness(script: Array<Response | Error>, stopAfter = MAX_STREAM_DROPS + 2): Harness {
  const waits: number[] = [];
  const files: MeetingFile[] = [];
  const calls: string[] = [];
  const onOpen = vi.fn(() => calls.push('open'));
  const onUnauthorized = vi.fn();
  const onUnavailable = vi.fn();
  const controller = new AbortController();
  let call = 0;

  const fetchMock = vi.fn(() => {
    const next = script[Math.min(call, script.length - 1)];
    call += 1;

    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    waits,
    files,
    calls,
    onOpen,
    onUnauthorized,
    onUnavailable,
    fetchMock,
    controller,
    run: () =>
      watchMeetingFiles({
        token: 'token-1',
        meetingId: 'm1',
        signal: controller.signal,
        onOpen,
        onFile: (file) => {
          calls.push(`file ${file.id}`);
          files.push(file);
        },
        onUnauthorized,
        onUnavailable,
        wait: (ms) => {
          waits.push(ms);

          if (waits.length >= stopAfter) {
            controller.abort();
          }

          return Promise.resolve();
        },
      }),
  };
}

describe('watchMeetingFiles', () => {
  it('reports each file event in order and ignores the heartbeats between them', async () => {
    const { run, files } = harness([
      stream(`event: ping\n\n${fileEvent(FILE)}event: ping\n\n${fileEvent(PROCESSING)}`),
    ]);

    await run();

    expect(files).toEqual([FILE, PROCESSING]);
  });

  it('reports the open before the first event, so the refetch it triggers overlaps the stream', async () => {
    const { run, calls } = harness([stream(`event: ping\n\n${fileEvent(FILE)}`)], 1);

    await run();

    // An event applied before the caller has asked for a list would be applied to nothing;
    // one applied after is replayed on top of the list when it lands. Open first, always.
    expect(calls).toEqual(['open', 'file f1']);
  });

  it('drops an event whose data is not a file, and keeps reading the rest', async () => {
    const { run, files } = harness([
      stream(`event: file\ndata: not json\n\nevent: file\ndata: {"no":"id"}\n\n${fileEvent(FILE)}`),
    ]);

    await run();

    // One unreadable event must not end a stream that is otherwise working.
    expect(files).toEqual([FILE]);
  });

  it('reopens when the server ends the stream, and reports every open', async () => {
    const { run, onOpen, waits, fetchMock } = harness([stream('event: ping\n\n')]);

    await run();

    // The API closes a stream at its TTL, so an ending is the ordinary case. Each reopen is
    // reported, because the list is stale from the moment the last stream stopped and only
    // a list requested after the server is subscribed again can say what was missed.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(onOpen).toHaveBeenCalledTimes(fetchMock.mock.calls.length);
    expect(waits[0]).toBe(RECONNECT_DELAYS_MS[0]);
  });

  it('reports no open for a connection that was refused', async () => {
    const { run, onOpen } = harness([new TypeError('Failed to fetch')]);

    await run();

    // A refetch here would be a fetch for every failed attempt, and there is nothing a
    // stream that never opened could have missed that the previous open did not cover.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('backs off across consecutive failures to open', async () => {
    const { run, waits } = harness([new TypeError('Failed to fetch')]);

    await run();

    // Three drops inside a minute is the give-up rule, so with failures this close together
    // only the first two delays are ever reached.
    expect(waits.slice(0, 2)).toEqual([RECONNECT_DELAYS_MS[0], RECONNECT_DELAYS_MS[1]]);
  });

  it('gives up after three drops inside a minute, and says so exactly once', async () => {
    const { run, onUnavailable, fetchMock } = harness([new TypeError('Failed to fetch')]);

    await run();

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_STREAM_DROPS);
  });

  it('keeps reconnecting when the drops are spread beyond the window', async () => {
    // Only `Date` is faked: nothing here waits on a timer.
    vi.useFakeTimers({ toFake: ['Date'] });
    const onUnavailable = vi.fn();
    const controller = new AbortController();
    let waits = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    await watchMeetingFiles({
      token: 'token-1',
      meetingId: 'm1',
      signal: controller.signal,
      onOpen: vi.fn(),
      onFile: vi.fn(),
      onUnauthorized: vi.fn(),
      onUnavailable,
      wait: () => {
        waits += 1;
        // A stream that works for a while and then dies: no three drops are ever recent, so
        // the give-up rule must not fire however many there have been in total.
        vi.setSystemTime(Date.now() + DROP_WINDOW_MS + 1_000);

        if (waits >= MAX_STREAM_DROPS + 3) {
          controller.abort();
        }

        return Promise.resolve();
      },
    });

    expect(waits).toBe(MAX_STREAM_DROPS + 3);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('stops for good on a 401 and hands it to the caller', async () => {
    const { run, onUnauthorized, onUnavailable, fetchMock } = harness([
      jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }),
    ]);

    await run();

    // Reopening would only produce another 401, and the gate is about to leave the page.
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves without opening anything when the signal is already aborted', async () => {
    const { run, controller, fetchMock, onOpen } = harness([stream('event: ping\n\n')]);
    controller.abort();

    await expect(run()).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('stops reconnecting once the caller aborts mid-wait', async () => {
    const { run, controller, fetchMock } = harness([stream('event: ping\n\n')], 1);

    await run();

    // One connection, one wait, then the abort: leaving the page must not leave a watch
    // opening connections against a component that is gone.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
  });
});
