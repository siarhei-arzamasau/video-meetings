import type { MeetingFile } from '@repo/shared';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, uploadMeetingFile } from '@/lib/api-client';
import type * as ApiClient from '@/lib/api-client';
import { fingerprint, uploadInChunks } from '@/lib/chunked-upload';
import type * as ChunkedUpload from '@/lib/chunked-upload';
import type { ChunkedUploadOptions } from '@/lib/chunked-upload';
import { isChunkedUpload } from '@/lib/meeting-files';
import type * as MeetingFiles from '@/lib/meeting-files';
import { recallUploadSession } from '@/lib/upload-sessions';

import { useUploadQueue } from './use-upload-queue';

// Partial mocks throughout: `ApiError` stays the class the queue tells a 401 apart with,
// `fingerprint` and the client-side checks stay real, and the remembered sessions live in
// jsdom's real localStorage — so a retry resuming its session is the real mechanism at work.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  uploadMeetingFile: vi.fn(),
  abortUpload: vi.fn(),
}));

vi.mock('@/lib/chunked-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof ChunkedUpload>()),
  uploadInChunks: vi.fn(),
}));

// Whether a file is chunked is a size over 100 MB; deciding it here spares allocating one.
vi.mock('@/lib/meeting-files', async (importOriginal) => ({
  ...(await importOriginal<typeof MeetingFiles>()),
  isChunkedUpload: vi.fn(),
}));

const TOKEN = 'header.payload.signature';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const UPLOAD_ID = '66666666-6666-4666-8666-666666666666';

const STORED: MeetingFile = {
  id: '55555555-5555-4555-8555-555555555555',
  meetingId: MEETING_ID,
  uploaderId: '11111111-1111-4111-8111-111111111111',
  name: 'recording.pdf',
  contentType: 'application/pdf',
  size: 4,
  status: 'uploaded',
  createdAt: '2026-09-21T09:00:00.000Z',
};

const onUploaded = vi.fn();
const onUnauthorized = vi.fn();

function renderQueue() {
  return renderHook(() =>
    useUploadQueue({ token: TOKEN, meetingId: MEETING_ID, onUploaded, onUnauthorized }),
  );
}

/** A chunked upload that opens its session and then fails, the way a dropped network does. */
function failAfterSessionOpens(error: unknown) {
  vi.mocked(uploadInChunks).mockImplementationOnce(
    (_token: string, _meetingId: string, _file: File, options: ChunkedUploadOptions) => {
      options.onSession?.(UPLOAD_ID);

      return Promise.reject(error);
    },
  );
}

const pdf = (): File => new File(['%PDF'], 'recording.pdf', { lastModified: 1 });

beforeEach(() => {
  vi.mocked(isChunkedUpload).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('useUploadQueue', () => {
  it('keeps a chunked upload that failed mid-way as a row that can be retried', async () => {
    failAfterSessionOpens(new ApiError(503, 'The server is busy.'));
    const { result } = renderQueue();

    act(() => {
      result.current.enqueue([pdf()]);
    });

    await waitFor(() => {
      expect(result.current.uploads[0]).toMatchObject({
        status: 'failed',
        error: 'The server is busy.',
        canRetry: true,
        uploadId: UPLOAD_ID,
      });
    });
    expect(recallUploadSession(fingerprint(pdf()))).toBe(UPLOAD_ID);
  });

  it('offers no retry for a single-request upload, which has no session to resume', async () => {
    vi.mocked(isChunkedUpload).mockReturnValue(false);
    vi.mocked(uploadMeetingFile).mockRejectedValue(new ApiError(503, 'The server is busy.'));
    const { result } = renderQueue();

    act(() => {
      result.current.enqueue([pdf()]);
    });

    await waitFor(() => {
      expect(result.current.uploads[0]).toMatchObject({ status: 'failed', canRetry: false });
    });
  });

  it('resumes the remembered session on retry rather than starting over', async () => {
    failAfterSessionOpens(new TypeError('Failed to fetch'));
    vi.mocked(uploadInChunks).mockResolvedValueOnce(STORED);
    const { result } = renderQueue();

    act(() => {
      result.current.enqueue([pdf()]);
    });
    await waitFor(() => {
      expect(result.current.uploads[0]?.status).toBe('failed');
    });

    const failedRow = result.current.uploads[0];
    act(() => {
      result.current.retry(failedRow?.localId ?? '');
    });

    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith(STORED);
    });
    expect(vi.mocked(uploadInChunks).mock.calls[1]?.[3]).toMatchObject({ resumeFrom: UPLOAD_ID });
    expect(result.current.uploads).toEqual([]);
    // Finished, so a later pick of the same file starts a new session instead of this one.
    expect(recallUploadSession(fingerprint(pdf()))).toBeNull();
  });

  it('hands a 401 to the page instead of failing the row', async () => {
    failAfterSessionOpens(new ApiError(401, 'Unauthorized'));
    const { result } = renderQueue();

    act(() => {
      result.current.enqueue([pdf()]);
    });

    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
    expect(result.current.uploads[0]?.status).not.toBe('failed');
  });

  it('fails a file the client rejects without a request, and offers no retry', () => {
    const { result } = renderQueue();

    act(() => {
      result.current.enqueue([new File([], 'empty.pdf')]);
    });

    expect(result.current.uploads[0]).toMatchObject({ status: 'failed', canRetry: false });
    expect(uploadInChunks).not.toHaveBeenCalled();
    expect(uploadMeetingFile).not.toHaveBeenCalled();
  });
});
