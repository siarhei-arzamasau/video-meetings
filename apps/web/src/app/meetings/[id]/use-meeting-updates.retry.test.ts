import type { MeetingDigest, MeetingFile } from '@repo/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { ApiError, fetchMeetingDigest, listMeetingFiles } from '@/lib/api-client';
import { watchMeetingFiles } from '@/lib/meeting-file-stream';

import { MAX_DIGEST_RETRY_MS } from './digest/use-digest-fallback-poll';
import { POLL_INTERVAL_MS } from './files/use-meeting-files';
import type { MeetingUpdates } from './use-meeting-updates';
import { useMeetingUpdates } from './use-meeting-updates';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listMeetingFiles: vi.fn(),
  fetchMeetingDigest: vi.fn(),
}));
vi.mock('@/lib/meeting-file-stream', () => ({ watchMeetingFiles: vi.fn() }));

const READY: MeetingDigest = { meetingId: 'm1', version: 3, status: 'ready' };

const RECORDING: MeetingFile = {
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  transcriptionStatus: 'transcribed',
  createdAt: '2026-10-01T10:00:00.000Z',
};

const onUnauthorized = vi.fn();

async function mount(): Promise<{ current: MeetingUpdates }> {
  const { result } = renderHook(() => useMeetingUpdates('a-signed-jwt', 'm1', onUnauthorized));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return result;
}

/** How many times the digest is asked for while this much time passes. */
async function digestRequestsDuring(milliseconds: number): Promise<number> {
  const before = vi.mocked(fetchMeetingDigest).mock.calls.length;

  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });

  return vi.mocked(fetchMeetingDigest).mock.calls.length - before;
}

/** The next retry is sent exactly this long after the last, and not a millisecond sooner. */
async function expectNextRetryAfter(delay: number): Promise<void> {
  expect(await digestRequestsDuring(delay - 1)).toBe(0);
  expect(await digestRequestsDuring(1)).toBe(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(listMeetingFiles).mockResolvedValue([RECORDING]);
  // An open stream, so nothing here is the fallback poll's: every request is a retry.
  vi.mocked(watchMeetingFiles).mockImplementation(({ onOpen }) => {
    onOpen();

    return new Promise<void>(() => undefined);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('a digest fetch the API refused', () => {
  it.each([403, 404])(
    'is not asked for again after a %d, which asking again would not change',
    async (status) => {
      vi.mocked(fetchMeetingDigest).mockRejectedValue(new ApiError(status, 'Meeting not found'));
      const page = await mount();

      expect(await digestRequestsDuring(10 * MAX_DIGEST_RETRY_MS)).toBe(0);
      expect(page.current.digest).toBeNull();
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it.each([408, 429, 500, 503])('is asked for again after a %d, which may pass', async (status) => {
    vi.mocked(fetchMeetingDigest).mockRejectedValue(new ApiError(status, 'Not now'));
    await mount();

    expect(await digestRequestsDuring(POLL_INTERVAL_MS)).toBe(1);
  });
});

describe('a digest fetch that keeps failing', () => {
  it('is asked for less and less often, and then once a minute', async () => {
    vi.mocked(fetchMeetingDigest).mockRejectedValue(new TypeError('Failed to fetch'));
    await mount();

    // One after another: each wait starts where the last retry was sent.
    await [3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000].reduce(
      (waited, delay) => waited.then(() => expectNextRetryAfter(delay)),
      Promise.resolve(),
    );
  });

  it('starts from the interval again once a fetch has landed', async () => {
    vi.mocked(fetchMeetingDigest).mockRejectedValue(new TypeError('Failed to fetch'));
    const page = await mount();
    await digestRequestsDuring(3_000 + 6_000);

    vi.mocked(fetchMeetingDigest).mockResolvedValue(READY);
    expect(await digestRequestsDuring(12_000)).toBe(1);
    expect(page.current.digest).toEqual(READY);

    // Lost again: the stream reopening is what asks, and the first retry is an interval away.
    vi.mocked(fetchMeetingDigest).mockRejectedValue(new TypeError('Failed to fetch'));
    act(() => page.current.refreshDigest());
    await digestRequestsDuring(0);

    expect(await digestRequestsDuring(POLL_INTERVAL_MS)).toBe(1);
  });
});
