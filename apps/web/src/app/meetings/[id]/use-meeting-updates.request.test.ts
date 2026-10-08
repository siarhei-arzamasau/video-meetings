import type { MeetingDigest, MeetingFile } from '@repo/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { fetchMeetingDigest, listMeetingFiles } from '@/lib/api-client';
import { watchMeetingFiles } from '@/lib/meeting-file-stream';

import { POLL_INTERVAL_MS } from './files/use-meeting-files';
import type { MeetingUpdates } from './use-meeting-updates';
import { useMeetingUpdates } from './use-meeting-updates';

/*
 * What the page does with the two answers a Generate or a Retry can be given: the digest the
 * API took the request with, and a refusal. Both are the feed's to handle — the control only
 * hands them over — so they are pinned here, with nothing drawn.
 */
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listMeetingFiles: vi.fn(),
  fetchMeetingDigest: vi.fn(),
}));
vi.mock('@/lib/meeting-file-stream', () => ({ watchMeetingFiles: vi.fn() }));

const digest = (version: number, overrides: Partial<MeetingDigest> = {}): MeetingDigest => ({
  meetingId: 'm1',
  version,
  ...overrides,
});

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

const FAILED = digest(4, { status: 'failed', availableAction: 'retry' });
const onUnauthorized = vi.fn();

async function mount(): Promise<{ current: MeetingUpdates }> {
  const { result } = renderHook(() => useMeetingUpdates('a-signed-jwt', 'm1', onUnauthorized));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return result;
}

const digestRequests = (): number => vi.mocked(fetchMeetingDigest).mock.calls.length;

async function oneInterval(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(listMeetingFiles).mockResolvedValue([RECORDING]);
  vi.mocked(fetchMeetingDigest).mockResolvedValue(FAILED);
  // A network that cannot hold the stream: the page has nothing but its own requests.
  vi.mocked(watchMeetingFiles).mockImplementation(({ onUnavailable }) => {
    onUnavailable();

    return Promise.resolve();
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('the digest a request was answered with', () => {
  it('is taken as the digest, and without a stream is what starts the poll', async () => {
    const page = await mount();
    expect(await digestRequestsAcross(oneInterval)).toBe(0);

    act(() => page.current.acceptDigest(digest(5, { status: 'queued' })));

    expect(page.current.digest).toEqual(digest(5, { status: 'queued' }));
    // Nothing else would ever say the generation ended: no stream, and the answer is all
    // the page was told.
    expect(await digestRequestsAcross(oneInterval)).toBe(1);
  });

  it('replaces a digest of the same version, as a fetch does and an event does not', async () => {
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest(5, { status: 'queued' }));
    const page = await mount();
    const answered = digest(5, { status: 'queued' });

    act(() => page.current.acceptDigest(answered));

    expect(page.current.digest).toBe(answered);
  });

  it('is dropped when the page already holds a later one', async () => {
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest(7, { status: 'generating' }));
    const page = await mount();

    // The answer of a request a worker has already claimed: older than what is on the page.
    act(() => page.current.acceptDigest(digest(5, { status: 'queued' })));

    expect(page.current.digest).toEqual(digest(7, { status: 'generating' }));
  });

  it('is nobody’s when it is another meeting’s', async () => {
    const page = await mount();

    act(() => page.current.acceptDigest({ meetingId: 'm2', version: 9, status: 'queued' }));

    expect(page.current.digest).toEqual(FAILED);
  });
});

describe('a refused request', () => {
  it('is answered by fetching the digest, and only the digest', async () => {
    const page = await mount();
    const before = {
      digests: digestRequests(),
      lists: vi.mocked(listMeetingFiles).mock.calls.length,
    };
    vi.mocked(fetchMeetingDigest).mockResolvedValue(digest(6, { status: 'generating' }));

    act(() => page.current.refreshDigest());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(digestRequests()).toBe(before.digests + 1);
    expect(vi.mocked(listMeetingFiles).mock.calls.length).toBe(before.lists);
    expect(page.current.digest).toEqual(digest(6, { status: 'generating' }));
  });
});

/** How many times the digest is asked for while `during` runs. */
async function digestRequestsAcross(during: () => Promise<void>): Promise<number> {
  const before = digestRequests();

  await during();

  return digestRequests() - before;
}
