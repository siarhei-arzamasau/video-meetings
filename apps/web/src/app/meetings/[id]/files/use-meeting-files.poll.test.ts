import type { MeetingFile } from '@repo/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { listMeetingFiles } from '@/lib/api-client';
import { watchMeetingFiles } from '@/lib/meeting-file-stream';

import type { MeetingFiles } from './use-meeting-files';
import { POLL_INTERVAL_MS, useMeetingFiles } from './use-meeting-files';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listMeetingFiles: vi.fn(),
}));
vi.mock('@/lib/meeting-file-stream', () => ({ watchMeetingFiles: vi.fn() }));

const recording = (overrides: Partial<MeetingFile> = {}): MeetingFile => ({
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  createdAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

const onUnauthorized = vi.fn();

/** Mounts the hook on a network that cannot hold the stream, and lets the first lists land. */
async function mountWithoutStream(): Promise<{ current: MeetingFiles }> {
  const { result } = renderHook(() => useMeetingFiles('a-signed-jwt', 'm1', onUnauthorized));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return result;
}

/** What a row does once its Retry is answered, and lets that one fetch come back. */
async function refetch(files: { current: MeetingFiles }): Promise<void> {
  await act(async () => {
    files.current.refresh();
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** How many times the list is asked for across one poll interval. */
async function listRequestsDuringOneInterval(): Promise<number> {
  const before = vi.mocked(listMeetingFiles).mock.calls.length;

  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });

  return vi.mocked(listMeetingFiles).mock.calls.length - before;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Given up on at once: what a proxy that will not hold a response open ends in.
  vi.mocked(watchMeetingFiles).mockImplementation(({ onUnavailable }) => {
    onUnavailable();

    return Promise.resolve();
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('the fallback poll', () => {
  it.each<[string, Partial<MeetingFile>, number]>([
    ['a file still being processed', { status: 'processing' }, 1],
    ['a queued recording', { transcriptionStatus: 'queued' }, 1],
    ['a recording being transcribed', { transcriptionStatus: 'transcribing' }, 1],
    ['a transcribed recording', { transcriptionStatus: 'transcribed' }, 0],
    ['a failed transcription', { transcriptionStatus: 'failed' }, 0],
    ['a ready file with no transcription', {}, 0],
  ])('for %s', async (_case, overrides, expected) => {
    vi.mocked(listMeetingFiles).mockResolvedValue([recording(overrides)]);
    await mountWithoutStream();

    expect(await listRequestsDuringOneInterval()).toBe(expected);
  });

  it('stops once the transcript has arrived', async () => {
    vi.mocked(listMeetingFiles).mockResolvedValue([
      recording({ transcriptionStatus: 'transcribing' }),
    ]);
    await mountWithoutStream();
    vi.mocked(listMeetingFiles).mockResolvedValue([
      recording({ transcriptionStatus: 'transcribed' }),
    ]);

    // The poll that finds it done is the last one.
    expect(await listRequestsDuringOneInterval()).toBe(1);
    expect(await listRequestsDuringOneInterval()).toBe(0);
  });

  it('keeps asking after a poll that failed, so an API that was restarting is caught up with', async () => {
    vi.mocked(listMeetingFiles).mockResolvedValue([
      recording({ transcriptionStatus: 'transcribing' }),
    ]);
    await mountWithoutStream();
    // The API is down: a poll that fails leaves the list as it was.
    vi.mocked(listMeetingFiles).mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await listRequestsDuringOneInterval()).toBe(1);
    expect(await listRequestsDuringOneInterval()).toBe(1);

    // And it is back, with the transcript finished meanwhile.
    vi.mocked(listMeetingFiles).mockResolvedValue([
      recording({ transcriptionStatus: 'transcribed' }),
    ]);

    expect(await listRequestsDuringOneInterval()).toBe(1);
    expect(await listRequestsDuringOneInterval()).toBe(0);
  });

  it('asks again after a refetch that failed, though the list it kept shows nothing awaited', async () => {
    const failed = recording({ transcriptionStatus: 'failed' });
    const queued = recording({ transcriptionStatus: 'queued' });
    vi.mocked(listMeetingFiles).mockResolvedValue([failed]);
    const files = await mountWithoutStream();

    // The retry was answered, so a worker is owed — and the refetch that would say so is lost.
    vi.mocked(listMeetingFiles).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.mocked(listMeetingFiles).mockResolvedValue([queued]);
    await refetch(files);
    expect(files.current.list).toEqual({ state: 'ready', files: [failed] });

    // The poll asks for it again, and from there it is the ordinary one: a queued recording.
    expect(await listRequestsDuringOneInterval()).toBe(1);
    expect(files.current.list).toEqual({ state: 'ready', files: [queued] });
    expect(await listRequestsDuringOneInterval()).toBe(1);
  });

  it('stops again once that refetch has landed on a list with nothing awaited', async () => {
    vi.mocked(listMeetingFiles).mockResolvedValue([recording({ transcriptionStatus: 'failed' })]);
    const files = await mountWithoutStream();

    vi.mocked(listMeetingFiles).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await refetch(files);

    expect(await listRequestsDuringOneInterval()).toBe(1);
    expect(await listRequestsDuringOneInterval()).toBe(0);
  });
});
