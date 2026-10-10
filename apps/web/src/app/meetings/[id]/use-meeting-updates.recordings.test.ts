import type { MeetingDigest, MeetingFile } from '@repo/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { fetchMeetingDigest, listMeetingFiles } from '@/lib/api-client';
import { watchMeetingFiles } from '@/lib/meeting-file-stream';

import type { MeetingUpdates } from './use-meeting-updates';
import { useMeetingUpdates } from './use-meeting-updates';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listMeetingFiles: vi.fn(),
  fetchMeetingDigest: vi.fn(),
}));
vi.mock('@/lib/meeting-file-stream', () => ({ watchMeetingFiles: vi.fn() }));

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

/** A digest built from `RECORDING`, as the API answers while that recording is there. */
const SHOWN: MeetingDigest = {
  meetingId: 'm1',
  version: 4,
  status: 'ready',
  content: {
    summary: 'The team agreed to ship on Friday.',
    actionItems: [],
    decisions: [],
    generatedAt: '2026-10-01T10:05:00.000Z',
    outOfDate: false,
  },
};

/**
 * The same digest once the recording is deleted: the API withholds the content from the
 * moment the delete commits, **under the version it had** — moving it is the work of a
 * reaction that, in these tests, never ran.
 */
const WITHHELD: MeetingDigest = { meetingId: 'm1', version: 4, status: 'ready' };

const onUnauthorized = vi.fn();

/** What the open stream hands the page: set when the hook starts watching. */
let stream: { onFile(file: MeetingFile): void };

async function mount(): Promise<{ current: MeetingUpdates }> {
  const { result } = renderHook(() => useMeetingUpdates('a-signed-jwt', 'm1', onUnauthorized));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  // A stream that opens and stays open, and says nothing about the digest: whatever the
  // page learns about it here, it learns by asking.
  vi.mocked(watchMeetingFiles).mockImplementation(({ onOpen, onFile }) => {
    stream = { onFile };
    onOpen();

    return new Promise<void>(() => undefined);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('a recording that leaves the list beside an open stream', () => {
  beforeEach(() => {
    vi.mocked(listMeetingFiles).mockResolvedValue([RECORDING]);
    vi.mocked(fetchMeetingDigest).mockResolvedValue(SHOWN);
  });

  it('takes its digest off the page when the stream reports the delete and no digest event follows', async () => {
    const page = await mount();
    expect(page.current.digest).toEqual(SHOWN);
    vi.mocked(fetchMeetingDigest).mockResolvedValue(WITHHELD);

    await act(async () => {
      stream.onFile({ ...RECORDING, status: 'deleted' });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(page.current.digest).toEqual(WITHHELD);
  });

  it('does the same for the page’s own delete', async () => {
    const page = await mount();
    vi.mocked(fetchMeetingDigest).mockResolvedValue(WITHHELD);

    await act(async () => {
      page.current.files.remove('f1');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(page.current.digest).toEqual(WITHHELD);
  });
});

describe('a recording transcribed beside an open stream', () => {
  it('asks for the digest, so one whose own event was lost is on the page all the same', async () => {
    const transcribing: MeetingFile = { ...RECORDING, transcriptionStatus: 'transcribing' };
    vi.mocked(listMeetingFiles).mockResolvedValue([transcribing]);
    vi.mocked(fetchMeetingDigest).mockResolvedValue({ meetingId: 'm1', version: 0 });
    const page = await mount();
    // Queued by the recording's request, and announced to nobody: the stream sends nothing.
    const queued: MeetingDigest = { meetingId: 'm1', version: 1, status: 'queued' };
    vi.mocked(fetchMeetingDigest).mockResolvedValue(queued);

    await act(async () => {
      stream.onFile(RECORDING);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(page.current.digest).toEqual(queued);
  });

  it('asks nothing for a change that leaves the transcribed recordings as they were', async () => {
    vi.mocked(listMeetingFiles).mockResolvedValue([RECORDING]);
    vi.mocked(fetchMeetingDigest).mockResolvedValue(SHOWN);
    await mount();
    const before = vi.mocked(fetchMeetingDigest).mock.calls.length;

    await act(async () => {
      stream.onFile({ ...RECORDING, id: 'f2', name: 'notes.pdf', transcriptionStatus: undefined });
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(vi.mocked(fetchMeetingDigest).mock.calls.length).toBe(before);
  });
});
