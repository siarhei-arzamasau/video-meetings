import type { MeetingDigest, MeetingFile } from '@repo/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { fetchMeetingDigest, listMeetingFiles } from '@/lib/api-client';
import { watchMeetingFiles } from '@/lib/meeting-file-stream';

import { POLL_INTERVAL_MS } from './files/use-meeting-files';
import type { MeetingUpdates } from './use-meeting-updates';
import { useMeetingUpdates } from './use-meeting-updates';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listMeetingFiles: vi.fn(),
  fetchMeetingDigest: vi.fn(),
}));
vi.mock('@/lib/meeting-file-stream', () => ({ watchMeetingFiles: vi.fn() }));

const digest = (overrides: Partial<MeetingDigest> = {}): MeetingDigest => ({
  meetingId: 'm1',
  version: 1,
  ...overrides,
});

const recording = (overrides: Partial<MeetingFile> = {}): MeetingFile => ({
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  transcriptionStatus: 'transcribed',
  createdAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

const onUnauthorized = vi.fn();

async function mount(): Promise<{ current: MeetingUpdates }> {
  const { result } = renderHook(() => useMeetingUpdates('a-signed-jwt', 'm1', onUnauthorized));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return result;
}

/** How many times the digest is asked for across one poll interval. */
async function digestRequestsDuringOneInterval(): Promise<number> {
  const before = vi.mocked(fetchMeetingDigest).mock.calls.length;

  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });

  return vi.mocked(fetchMeetingDigest).mock.calls.length - before;
}

/** A network that cannot hold the stream: given up on at once. */
function withoutStream(): void {
  vi.mocked(watchMeetingFiles).mockImplementation(({ onUnavailable }) => {
    onUnavailable();

    return Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(listMeetingFiles).mockResolvedValue([recording()]);
  withoutStream();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("the digest's fallback poll", () => {
  it.each<[string, Partial<MeetingDigest>, number]>([
    ['a queued digest', { status: 'queued' }, 1],
    ['a digest being generated', { status: 'generating' }, 1],
    ['a ready digest', { status: 'ready' }, 0],
    ['a failed digest', { status: 'failed' }, 0],
    ['a meeting with no digest', { version: 0 }, 0],
  ])('for %s', async (_case, overrides, expected) => {
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest(overrides));
    await mount();

    expect(await digestRequestsDuringOneInterval()).toBe(expected);
  });

  it('does not run beside a stream, which says everything it would', async () => {
    vi.mocked(watchMeetingFiles).mockImplementation(({ onOpen }) => {
      onOpen();

      return new Promise<void>(() => undefined);
    });
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ status: 'generating' }));
    await mount();

    expect(await digestRequestsDuringOneInterval()).toBe(0);
  });

  it('stops once the digest has arrived', async () => {
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ status: 'generating' }));
    const page = await mount();
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ version: 2, status: 'ready' }));

    expect(await digestRequestsDuringOneInterval()).toBe(1);
    expect(page.current.digest?.status).toBe('ready');
    expect(await digestRequestsDuringOneInterval()).toBe(0);
  });

  it('keeps asking after a poll that failed, so an API that was restarting is caught up with', async () => {
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ status: 'generating' }));
    const page = await mount();
    vi.mocked(fetchMeetingDigest).mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await digestRequestsDuringOneInterval()).toBe(1);
    expect(await digestRequestsDuringOneInterval()).toBe(1);

    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ version: 2, status: 'ready' }));

    expect(await digestRequestsDuringOneInterval()).toBe(1);
    expect(page.current.digest?.status).toBe('ready');
    expect(await digestRequestsDuringOneInterval()).toBe(0);
  });

  it('asks again when the list gains a transcribed recording, which is what starts a digest', async () => {
    const transcribing = recording({ transcriptionStatus: 'transcribing' });
    vi.mocked(listMeetingFiles).mockResolvedValue([transcribing]);
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ version: 0 }));
    const page = await mount();

    // The files' own poll finds the transcript done. Nothing about a digest with no status
    // would ever have the page ask for it again, and no stream is there to say it was queued.
    vi.mocked(listMeetingFiles).mockResolvedValue([recording()]);
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ status: 'queued' }));

    expect(await digestRequestsDuringOneInterval()).toBe(1);
    expect(page.current.digest?.status).toBe('queued');
    // And from there it is the ordinary poll: a queued digest.
    expect(await digestRequestsDuringOneInterval()).toBe(1);
  });

  it('asks again when a transcribed recording leaves the list, which is what withdraws one', async () => {
    const shown = digest({ version: 4, status: 'ready' });
    vi.mocked(fetchMeetingDigest).mockResolvedValue(shown);
    const page = await mount();
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ version: 5 }));
    const before = vi.mocked(fetchMeetingDigest).mock.calls.length;

    // The page's own delete, taken out of the list at once.
    await act(async () => {
      page.current.files.remove('f1');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(vi.mocked(fetchMeetingDigest).mock.calls.length).toBe(before + 1);
    expect(page.current.digest).toEqual(digest({ version: 5 }));
  });

  it('asks once more an interval after that change, for what the API had not decided yet', async () => {
    const shown = digest({ version: 4, status: 'ready' });
    vi.mocked(fetchMeetingDigest).mockResolvedValue(shown);
    const page = await mount();

    // The API answers a delete before it has followed it: the fetch sent at once is given
    // the digest as it was, which is nothing a poll would run on.
    await act(async () => {
      page.current.files.remove('f1');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(page.current.digest).toEqual(shown);

    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ version: 6, status: 'queued' }));

    expect(await digestRequestsDuringOneInterval()).toBe(1);
    expect(page.current.digest?.status).toBe('queued');
  });

  it('asks only once more when the digest stays as it was, as it does with the setting off', async () => {
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ version: 4, status: 'ready' }));
    const page = await mount();

    await act(async () => {
      page.current.files.remove('f1');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(await digestRequestsDuringOneInterval()).toBe(1);
    expect(await digestRequestsDuringOneInterval()).toBe(0);
  });
});

describe('a digest fetch that failed beside an open stream', () => {
  beforeEach(() => {
    vi.mocked(watchMeetingFiles).mockImplementation(({ onOpen }) => {
      onOpen();

      return new Promise<void>(() => undefined);
    });
  });

  it('is asked for again, because no event announces a digest that is simply there', async () => {
    vi.mocked(fetchMeetingDigest).mockRejectedValue(new TypeError('Failed to fetch'));
    const page = await mount();
    expect(page.current.digest).toBeNull();

    expect(await digestRequestsDuringOneInterval()).toBe(1);

    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ version: 3, status: 'ready' }));

    expect(await digestRequestsDuringOneInterval()).toBe(1);
    expect(page.current.digest).toEqual(digest({ version: 3, status: 'ready' }));
    // And that is the end of it: the stream says the rest.
    expect(await digestRequestsDuringOneInterval()).toBe(0);
  });

  it('leaves a digest that is being generated to the stream once a fetch has landed', async () => {
    vi.mocked(fetchMeetingDigest).mockRejectedValue(new TypeError('Failed to fetch'));
    await mount();
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest({ status: 'generating' }));

    expect(await digestRequestsDuringOneInterval()).toBe(1);
    expect(await digestRequestsDuringOneInterval()).toBe(0);
  });
});
