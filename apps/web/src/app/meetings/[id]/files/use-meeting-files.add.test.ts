import type { MeetingFile } from '@repo/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { listMeetingFiles } from '@/lib/api-client';
import { watchMeetingFiles } from '@/lib/meeting-file-stream';

import type { MeetingFiles } from './use-meeting-files';
import { useMeetingFiles } from './use-meeting-files';

/*
 * The hook with only the API and the stream replaced. What is pinned here is an order between
 * two connections — the upload's answer and the stream's events about the same file.
 */
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
  status: 'uploaded',
  createdAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

const onUnauthorized = vi.fn();
const nothing = (): void => undefined;

interface Mounted {
  files(): ReadonlyArray<MeetingFile>;
  /** One event from the stream, as the page would receive it. */
  deliver(file: MeetingFile): void;
  /** The upload's answer landing. */
  add(file: MeetingFile): void;
}

/** Mounts the hook on a stream that stays open, and lets the first lists land. */
async function mountWithStream(): Promise<Mounted> {
  let onFile: (file: MeetingFile) => void = nothing;

  vi.mocked(watchMeetingFiles).mockImplementation((options) => {
    onFile = options.onFile;
    options.onOpen();

    // Never settles: the stream is open for as long as the test runs.
    return new Promise<void>(() => undefined);
  });

  const { result } = renderHook<MeetingFiles, unknown>(() =>
    useMeetingFiles('a-signed-jwt', 'm1', onUnauthorized),
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return {
    files: () => (result.current.list.state === 'ready' ? result.current.list.files : []),
    deliver: (file) => act(() => onFile(file)),
    add: (file) => act(() => result.current.add(file)),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the upload's answer", () => {
  it('does not go over a row the stream has already moved on', async () => {
    vi.mocked(listMeetingFiles).mockResolvedValue([]);
    const page = await mountWithStream();

    // The file worker finished before the upload's own response arrived: the stream has said
    // `uploaded`, `processing`, and `ready` with the transcription queued.
    page.deliver(recording({ status: 'ready', transcriptionStatus: 'queued' }));
    page.add(recording({ status: 'uploaded' }));

    expect(page.files()).toEqual([recording({ status: 'ready', transcriptionStatus: 'queued' })]);
  });

  it('puts a file the list does not have yet at the top', async () => {
    const earlier = recording({ id: 'f0', name: 'agenda.pdf', status: 'ready' });

    vi.mocked(listMeetingFiles).mockResolvedValue([earlier]);
    const page = await mountWithStream();

    page.add(recording());

    expect(page.files().map(({ id }) => id)).toEqual(['f1', 'f0']);
  });

  it('asks for the list again while there is none to put it in', async () => {
    // Never answered: the list is still loading when the upload finishes.
    vi.mocked(listMeetingFiles).mockReturnValue(new Promise(() => undefined));
    const page = await mountWithStream();
    const asked = vi.mocked(listMeetingFiles).mock.calls.length;

    page.add(recording());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(vi.mocked(listMeetingFiles).mock.calls.length).toBe(asked + 1);
  });
});
