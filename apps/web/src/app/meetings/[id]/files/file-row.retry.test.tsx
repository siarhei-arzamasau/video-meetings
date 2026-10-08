import type { MeetingFile } from '@repo/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { ApiError, retryMeetingFile, retryMeetingFileTranscription } from '@/lib/api-client';

import { FileRow } from './file-row';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  retryMeetingFile: vi.fn(),
  retryMeetingFileTranscription: vi.fn(),
}));

const READY: MeetingFile = {
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  createdAt: '2026-10-01T10:00:00.000Z',
};

interface RetryCase {
  /** The row before the press. */
  failed: MeetingFile;
  /** What the API answers a retry of it with. */
  answer: MeetingFile;
  request: typeof retryMeetingFile;
  /** The other retry, which this row must never send. */
  otherRequest: typeof retryMeetingFile;
  chip: string;
}

const FILE_CASE: RetryCase = {
  failed: { ...READY, status: 'failed', failureReason: 'The image could not be read.' },
  answer: { ...READY, status: 'uploaded' },
  request: retryMeetingFile,
  otherRequest: retryMeetingFileTranscription,
  chip: 'Processing failed',
};

/** The recording is `ready` before the retry and after it: only its transcription moves. */
const TRANSCRIPTION_CASE: RetryCase = {
  failed: {
    ...READY,
    transcriptionStatus: 'failed',
    transcriptionFailureReason: 'The recording could not be transcribed.',
  },
  answer: { ...READY, transcriptionStatus: 'queued' },
  request: retryMeetingFileTranscription,
  otherRequest: retryMeetingFile,
  chip: 'Transcription failed',
};

/** One table for both: the plan's "as the file retry does" is that every case below holds twice. */
const CASES: ReadonlyArray<[string, RetryCase]> = [
  ['a failed file', FILE_CASE],
  ['a failed transcription', TRANSCRIPTION_CASE],
];

const handlers = {
  onDelete: vi.fn(),
  onRetried: vi.fn(),
  onStale: vi.fn(),
  onUnauthorized: vi.fn(),
};

function renderRow(file: MeetingFile, canManage = true) {
  return render(
    <FileRow token="a-signed-jwt" file={file} isMine canManage={canManage} {...handlers} />,
  );
}

const retryButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Retry' });
const retryButtons = (): HTMLElement[] => screen.queryAllByRole('button', { name: 'Retry' });

beforeEach(() => {
  vi.mocked(retryMeetingFile).mockResolvedValue(FILE_CASE.answer);
  vi.mocked(retryMeetingFileTranscription).mockResolvedValue(TRANSCRIPTION_CASE.answer);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe.each(CASES)('Retry on %s', (_case, { failed, answer, request, otherRequest, chip }) => {
  it('sends the retry and tells the list the API took it, without the answer', async () => {
    vi.mocked(request).mockResolvedValue(answer);
    renderRow(failed);

    await userEvent.setup().click(retryButton());

    await waitFor(() => {
      expect(handlers.onRetried).toHaveBeenCalledExactlyOnceWith();
    });
    expect(request).toHaveBeenCalledExactlyOnceWith('a-signed-jwt', 'm1', 'f1');
    expect(otherRequest).not.toHaveBeenCalled();
    expect(handlers.onStale).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cannot be pressed again while the answer is on its way', async () => {
    // Settled by hand, so there is a moment between the press and the answer to look at.
    const arrival: { resolve?: (file: MeetingFile) => void } = {};
    vi.mocked(request).mockReturnValue(
      new Promise<MeetingFile>((resolve) => {
        arrival.resolve = resolve;
      }),
    );
    renderRow(failed);
    const user = userEvent.setup();

    await user.click(retryButton());

    expect(retryButton().disabled).toBe(true);
    await user.click(retryButton());
    expect(request).toHaveBeenCalledTimes(1);

    arrival.resolve?.(answer);

    await waitFor(() => {
      expect(handlers.onRetried).toHaveBeenCalledExactlyOnceWith();
    });
  });

  it('is offered to the uploader or the host only, and the failure to everyone', () => {
    renderRow(failed, false);

    expect(retryButtons()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByText(chip)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Download' })).toBeDefined();
  });

  it('signs out on a 401 and reports nothing', async () => {
    vi.mocked(request).mockRejectedValue(new ApiError(401, 'Unauthorized'));
    renderRow(failed);

    await userEvent.setup().click(retryButton());

    await waitFor(() => {
      expect(handlers.onUnauthorized).toHaveBeenCalledTimes(1);
    });
    expect(handlers.onRetried).not.toHaveBeenCalled();
    expect(handlers.onStale).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refetches the list on a 409 rather than reporting it', async () => {
    // Somebody else got there first: what the row is now is the list's to say.
    vi.mocked(request).mockRejectedValue(new ApiError(409, 'No longer failed'));
    renderRow(failed);

    await userEvent.setup().click(retryButton());

    await waitFor(() => {
      expect(handlers.onStale).toHaveBeenCalledTimes(1);
    });
    expect(handlers.onRetried).not.toHaveBeenCalled();
    expect(handlers.onUnauthorized).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it("shows any other refusal inline, in the API's words, until it is dismissed", async () => {
    vi.mocked(request).mockRejectedValue(new ApiError(404, 'File not found'));
    renderRow(failed);
    const user = userEvent.setup();

    await user.click(retryButton());

    expect((await screen.findByRole('alert')).textContent).toBe('File not found');
    expect(handlers.onStale).not.toHaveBeenCalled();
    expect(handlers.onUnauthorized).not.toHaveBeenCalled();
    // Still failed, so still retryable: the message is not the end of the road.
    expect(retryButton().disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('says so when the request never reached the API', async () => {
    vi.mocked(request).mockRejectedValue(new TypeError('Failed to fetch'));
    renderRow(failed);

    await userEvent.setup().click(retryButton());

    expect((await screen.findByRole('alert')).textContent).toBe('The retry failed. Try again.');
  });

  it('clears the last refusal when it is pressed again', async () => {
    vi.mocked(request).mockRejectedValueOnce(new ApiError(404, 'File not found'));
    vi.mocked(request).mockResolvedValueOnce(answer);
    renderRow(failed);
    const user = userEvent.setup();

    await user.click(retryButton());
    await screen.findByRole('alert');
    await user.click(retryButton());

    await waitFor(() => {
      expect(handlers.onRetried).toHaveBeenCalledExactlyOnceWith();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('a row with nothing failed', () => {
  it.each<[string, Partial<MeetingFile>]>([
    ['a ready file that is not a recording', { name: 'deck.pdf', contentType: 'application/pdf' }],
    ['a file still being processed', { status: 'processing' }],
    ['a queued recording', { transcriptionStatus: 'queued' }],
    ['a recording being transcribed', { transcriptionStatus: 'transcribing' }],
    [
      'a transcribed recording',
      { transcriptionStatus: 'transcribed', transcriptPath: '/meetings/m1/files/f1/transcript' },
    ],
  ])('offers no Retry on %s', (_case, overrides) => {
    renderRow({ ...READY, ...overrides });

    expect(retryButtons()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Download' })).toBeDefined();
  });
});

describe('a row that claims both failures', () => {
  it('offers one Retry, and it is the file that goes back', async () => {
    // The API writes no such row; the page must still never draw two buttons of one name.
    renderRow({ ...FILE_CASE.failed, transcriptionStatus: 'failed' });

    expect(retryButtons()).toHaveLength(1);
    await userEvent.setup().click(retryButton());

    await waitFor(() => {
      expect(handlers.onRetried).toHaveBeenCalledExactlyOnceWith();
    });
    expect(retryMeetingFileTranscription).not.toHaveBeenCalled();
  });
});
