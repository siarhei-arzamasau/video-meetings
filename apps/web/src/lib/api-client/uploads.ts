import type { MeetingFile, MeetingFileUpload } from '@repo/shared';

import type { UploadOptions, XhrFactory } from './core';
import { apiFetch, authHeaders, sendWithProgress } from './core';

/** The chunked upload's five calls, in the order a client makes them. */
const uploadsPath = (meetingId: string): string => `/meetings/${meetingId}/files/uploads`;
const uploadPath = (meetingId: string, uploadId: string): string =>
  `${uploadsPath(meetingId)}/${uploadId}`;

/**
 * Opens a session for a file too large for one request. The server answers with the chunk
 * plan — size and count — which the client obeys rather than chooses.
 *
 * A 413 means the file is over the chunked cap, a 409 that the meeting is full.
 */
export function createUpload(
  token: string,
  meetingId: string,
  file: Pick<File, 'name' | 'size'>,
): Promise<MeetingFileUpload> {
  return apiFetch<MeetingFileUpload>(uploadsPath(meetingId), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name: file.name, size: file.size }),
  });
}

/**
 * The session as the server sees it, above all its `receivedChunks`. This is what makes a
 * resume cheap: the client sends only what is missing, and never asks the user to wait for
 * bytes the server already has. A 404 means the session expired, was aborted, or completed.
 */
export function getUpload(
  token: string,
  meetingId: string,
  uploadId: string,
): Promise<MeetingFileUpload> {
  return apiFetch<MeetingFileUpload>(uploadPath(meetingId, uploadId), {
    headers: authHeaders(token),
  });
}

/**
 * One chunk, as raw bytes. `XMLHttpRequest` for the same reason `uploadMeetingFile` is one:
 * per-chunk progress is what makes a percentage move on a long upload, and an `AbortSignal`
 * is what makes Cancel immediate rather than "after this chunk".
 *
 * The API answers 204, so this resolves to nothing.
 */
export function putChunk(
  token: string,
  meetingId: string,
  uploadId: string,
  index: number,
  chunk: Blob,
  options: UploadOptions = {},
  createXhr: XhrFactory = () => new XMLHttpRequest(),
): Promise<void> {
  return sendWithProgress<void>(
    {
      method: 'PUT',
      path: `${uploadPath(meetingId, uploadId)}/chunks/${String(index)}`,
      token,
      body: chunk,
      contentType: 'application/octet-stream',
    },
    options,
    createXhr,
  );
}

/**
 * Assembles the session into a file. Safe to retry: a rejection here leaves every chunk on
 * the server, so a 415 or a dropped connection costs this call again, not the upload.
 */
export function completeUpload(
  token: string,
  meetingId: string,
  uploadId: string,
): Promise<MeetingFile> {
  return apiFetch<MeetingFile>(`${uploadPath(meetingId, uploadId)}/complete`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

/** Gives up on a session. A 404 means it was already gone — which is the same outcome. */
export function abortUpload(token: string, meetingId: string, uploadId: string): Promise<void> {
  return apiFetch<void>(uploadPath(meetingId, uploadId), {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}
