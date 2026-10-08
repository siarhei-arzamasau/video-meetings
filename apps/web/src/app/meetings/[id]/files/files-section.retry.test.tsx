import type { Meeting, MeetingFile, User } from '@repo/shared';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import {
  listMeetingFiles,
  retryMeetingFile,
  retryMeetingFileTranscription,
} from '@/lib/api-client';
import { watchMeetingFiles } from '@/lib/meeting-file-stream';

import { FilesSection } from './files-section';

/*
 * The row, `useRetry`, the section and the list together, with only the API and the stream
 * replaced. What is pinned here is an order between two connections — the retry's answer and
 * the stream's events — and none of those four sees both on its own.
 */
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listMeetingFiles: vi.fn(),
  retryMeetingFile: vi.fn(),
  retryMeetingFileTranscription: vi.fn(),
}));
vi.mock('@/lib/meeting-file-stream', () => ({ watchMeetingFiles: vi.fn() }));

const USER: User = {
  id: 'u1',
  email: 'host@example.com',
  displayName: 'Host',
  avatarVersion: 0,
  createdAt: '2026-10-01T09:00:00.000Z',
};

const MEETING: Meeting = {
  id: 'm1',
  title: 'Engine review',
  status: 'scheduled',
  hostId: USER.id,
  scheduledAt: '2026-10-02T10:00:00.000Z',
  participantIds: [],
};

const READY: MeetingFile = {
  id: 'f1',
  meetingId: MEETING.id,
  uploaderId: USER.id,
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  createdAt: '2026-10-01T10:00:00.000Z',
};

interface RetryCase {
  request: typeof retryMeetingFile;
  /** The row before the press, and again once a worker has failed it a second time. */
  failed: MeetingFile;
  /** What the API answers the retry with: the row as the retry left it. */
  answer: MeetingFile;
  /** What a worker makes of it next, before failing it again. */
  claimed: MeetingFile;
  failedChip: string;
  /** What the row would say if the answer were on it. */
  answerChip: string;
}

const CASES: ReadonlyArray<[string, RetryCase]> = [
  [
    'a failed file',
    {
      request: retryMeetingFile,
      failed: { ...READY, status: 'failed', failureReason: 'The image could not be read.' },
      answer: { ...READY, status: 'uploaded' },
      claimed: { ...READY, status: 'processing' },
      failedChip: 'Processing failed',
      answerChip: 'Processing',
    },
  ],
  [
    'a failed transcription',
    {
      request: retryMeetingFileTranscription,
      failed: {
        ...READY,
        transcriptionStatus: 'failed',
        transcriptionFailureReason: 'The recording could not be transcribed.',
      },
      answer: { ...READY, transcriptionStatus: 'queued' },
      claimed: { ...READY, transcriptionStatus: 'transcribing' },
      failedChip: 'Transcription failed',
      answerChip: 'Queued for transcription',
    },
  ],
];

/** The page's end of the stream: what a test calls to have an event arrive. */
const stream: { deliver?: (file: MeetingFile) => void } = {};

/** A request the test answers by hand, so the answer can be made to arrive after an event. */
function heldRequest(request: typeof retryMeetingFile): (answer: MeetingFile) => void {
  const arrival: { resolve?: (file: MeetingFile) => void } = {};
  vi.mocked(request).mockReturnValue(
    new Promise<MeetingFile>((resolve) => {
      arrival.resolve = resolve;
    }),
  );

  return (answer) => arrival.resolve?.(answer);
}

/** Everything a worker did to the row after the retry, as the stream reports it, in order. */
function deliver(...events: MeetingFile[]): void {
  act(() => {
    for (const event of events) {
      // A copy each time: an event is a new object even when it says what the row already did.
      stream.deliver?.({ ...event });
    }
  });
}

const listRequests = (): number => vi.mocked(listMeetingFiles).mock.calls.length;
const retryButtons = (): HTMLElement[] => screen.queryAllByRole('button', { name: 'Retry' });
/** Exact, because "Processing failed" contains "Processing". */
const chips = (label: string): HTMLElement[] => screen.queryAllByText(label, { exact: true });

async function renderSection(): Promise<void> {
  render(
    <FilesSection token="a-signed-jwt" meeting={MEETING} user={USER} onUnauthorized={vi.fn()} />,
  );
  await screen.findByText('standup.mp3');
}

beforeEach(() => {
  vi.mocked(watchMeetingFiles).mockImplementation(({ onOpen, onFile }) => {
    stream.deliver = onFile;
    onOpen();

    return Promise.resolve();
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  delete stream.deliver;
});

describe.each(CASES)(
  'the answer to a retry of %s',
  (_case, { request, failed, answer, claimed, failedChip, answerChip }) => {
    it('does not put the row back when the stream got there first', async () => {
      vi.mocked(listMeetingFiles).mockResolvedValue([failed]);
      const answerRetry = heldRequest(request);
      await renderSection();

      await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
      // The retry itself, a worker's claim, and its second failure: all three overtake the
      // answer, which is still on its way on a connection of its own.
      deliver(answer, claimed, failed);
      const before = listRequests();
      await act(async () => {
        answerRetry(answer);
        await Promise.resolve();
      });

      // What the stream said last stays: failed, and retryable again.
      expect(chips(answerChip)).toEqual([]);
      expect(chips(failedChip)).toHaveLength(1);
      expect(retryButtons()).toHaveLength(1);
      // The answer is a cue to ask the list, which can be put in order against the stream.
      await waitFor(() => {
        expect(listRequests()).toBe(before + 1);
      });
      expect(chips(answerChip)).toEqual([]);
      expect(chips(failedChip)).toHaveLength(1);
      expect(retryButtons()).toHaveLength(1);
    });

    it('is followed by whatever the stream says after it', async () => {
      vi.mocked(listMeetingFiles).mockResolvedValue([failed]);
      vi.mocked(request).mockResolvedValue(answer);
      await renderSection();

      await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(request).toHaveBeenCalledTimes(1);
      });
      deliver(answer);

      expect(chips(answerChip)).toHaveLength(1);
      expect(retryButtons()).toEqual([]);

      deliver(claimed, failed);

      expect(chips(failedChip)).toHaveLength(1);
      expect(retryButtons()).toHaveLength(1);
    });

    it('reaches the row through a refetch when there is no stream to carry it', async () => {
      // Given up on at once: what a proxy that will not hold a response open ends in.
      vi.mocked(watchMeetingFiles).mockImplementation(({ onUnavailable }) => {
        onUnavailable();

        return Promise.resolve();
      });
      vi.mocked(listMeetingFiles).mockResolvedValue([failed]);
      vi.mocked(request).mockResolvedValue(answer);
      await renderSection();
      // From here the list is the API's after the retry, and the only thing that can say so.
      vi.mocked(listMeetingFiles).mockResolvedValue([answer]);
      const before = listRequests();

      await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));

      // At once, not at the next poll: nothing is awaiting a worker until this list says so.
      await waitFor(() => {
        expect(listRequests()).toBe(before + 1);
      });
      await waitFor(() => {
        expect(chips(answerChip)).toHaveLength(1);
      });
      expect(retryButtons()).toEqual([]);
    });
  },
);
