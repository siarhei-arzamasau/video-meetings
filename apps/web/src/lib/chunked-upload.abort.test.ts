import type { MeetingFile, MeetingFileUpload } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { completeUpload, createUpload, getUpload } from './api-client';
import type { ChunkedUploadDeps } from './chunked-upload';
import { uploadInChunks } from './chunked-upload';

const TOKEN = 'header.payload.signature';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const UPLOAD_ID = '66666666-6666-4666-8666-666666666666';

const STORED: MeetingFile = {
  id: 'f1',
  meetingId: MEETING_ID,
  uploaderId: 'u1',
  name: 'recording.mp4',
  contentType: 'video/mp4',
  size: 12,
  status: 'uploaded',
  createdAt: '2026-09-19T10:00:00.000Z',
};

/** One whole chunk received, one still to send. */
const SESSION: MeetingFileUpload = {
  id: UPLOAD_ID,
  meetingId: MEETING_ID,
  name: 'recording.mp4',
  size: 12,
  chunkSize: 8,
  chunkCount: 2,
  receivedChunks: [0],
  createdAt: '2026-09-19T10:00:00.000Z',
  expiresAt: '2026-09-20T10:00:00.000Z',
};

const file = (): File => new File([new Uint8Array(12)], 'recording.mp4');

const aborted = (): DOMException => new DOMException('The upload was aborted', 'AbortError');

function transport(overrides: Partial<ChunkedUploadDeps> = {}): ChunkedUploadDeps {
  return {
    createUpload: vi.fn(() => Promise.resolve(SESSION)),
    getUpload: vi.fn(() => Promise.resolve(SESSION)),
    putChunk: vi.fn(() => Promise.resolve()),
    completeUpload: vi.fn(() => Promise.resolve(STORED)),
    delay: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

/**
 * The queue ends an upload by aborting its signal when the page goes away. A chunked upload is
 * more requests than its chunks — it asks about a remembered session, opens one, and completes
 * it — and a signal handed only to the chunks left the other three running, with the token the
 * page had, after the user had left or signed out.
 */
describe('uploadInChunks, when it is aborted', () => {
  it('hands its signal to the lookup of a remembered session, each chunk, and the completion', async () => {
    const { signal } = new AbortController();
    const deps = transport();

    await uploadInChunks(TOKEN, MEETING_ID, file(), { signal, resumeFrom: UPLOAD_ID }, deps);

    expect(deps.getUpload).toHaveBeenCalledWith(TOKEN, MEETING_ID, UPLOAD_ID, signal);
    expect(vi.mocked(deps.putChunk).mock.calls[0]?.[5]).toMatchObject({ signal });
    expect(deps.completeUpload).toHaveBeenCalledWith(TOKEN, MEETING_ID, UPLOAD_ID, signal);
  });

  it('hands its signal to the request that opens a new session', async () => {
    const { signal } = new AbortController();
    const deps = transport();

    await uploadInChunks(TOKEN, MEETING_ID, file(), { signal }, deps);

    expect(deps.createUpload).toHaveBeenCalledWith(TOKEN, MEETING_ID, expect.any(File), signal);
  });

  // The longest of the four: the server assembles up to a gigabyte before it answers.
  it('stops waiting for a completion the moment it is aborted', async () => {
    const controller = new AbortController();
    const deps = transport({
      completeUpload: vi.fn(
        (_token: string, _meetingId: string, _uploadId: string, signal?: AbortSignal) =>
          new Promise<MeetingFile>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(aborted()), { once: true });
          }),
      ),
    });

    const uploading = uploadInChunks(
      TOKEN,
      MEETING_ID,
      file(),
      { signal: controller.signal, resumeFrom: UPLOAD_ID },
      deps,
    );
    await vi.waitFor(() => {
      expect(deps.completeUpload).toHaveBeenCalled();
    });

    controller.abort();

    await expect(uploading).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not take an aborted lookup for a session that is gone, and opens no new one', async () => {
    const controller = new AbortController();
    const deps = transport({ getUpload: vi.fn(() => Promise.reject(aborted())) });

    await expect(
      uploadInChunks(
        TOKEN,
        MEETING_ID,
        file(),
        { signal: controller.signal, resumeFrom: UPLOAD_ID },
        deps,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(deps.createUpload).not.toHaveBeenCalled();
  });
});

describe('the chunked upload wrappers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['createUpload', (signal: AbortSignal) => createUpload(TOKEN, MEETING_ID, file(), signal)],
    ['getUpload', (signal: AbortSignal) => getUpload(TOKEN, MEETING_ID, UPLOAD_ID, signal)],
    [
      'completeUpload',
      (signal: AbortSignal) => completeUpload(TOKEN, MEETING_ID, UPLOAD_ID, signal),
    ],
  ])('%s gives its signal to the request it makes', async (_name, call) => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(Response.json(SESSION)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { signal } = new AbortController();

    await call(signal);

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);
  });
});
