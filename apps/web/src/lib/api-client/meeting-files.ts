import type { MeetingFile } from '@repo/shared';

import type { UploadOptions, XhrFactory } from './core';
import {
  ApiError,
  apiFetch,
  apiFetchBlob,
  authHeaders,
  buildApiUrl,
  readErrorMessage,
  sendWithProgress,
} from './core';

/** Every non-deleted file of a meeting, newest first as the API orders them. */
export function listMeetingFiles(
  token: string,
  meetingId: string,
): Promise<ReadonlyArray<MeetingFile>> {
  return apiFetch<MeetingFile[]>(`/meetings/${meetingId}/files`, { headers: authHeaders(token) });
}

/**
 * The copy for a 200 that is not a stream — a proxy's interstitial, a dev server's HTML.
 * Not a status, because the status is fine; what is wrong is what came back.
 */
export const NOT_AN_EVENT_STREAM_MESSAGE = 'The server did not send an event stream.';

/**
 * Opens this meeting's file event stream. The caller reads the body with `readEventStream`.
 *
 * Not `apiFetch`: there is nothing to parse and the body is the point. It is still the same
 * boundary — `buildApiUrl` for the URL, the bearer header, and a non-2xx as an `ApiError`
 * carrying the API's own message, so a 401 here reaches the caller as the 401 every other
 * call produces and goes down the same clear-and-redirect path.
 *
 * **The content type is checked rather than assumed.** A proxy or a misconfigured dev server
 * can answer 200 with HTML, which the parser would read as a stream that carried nothing and
 * ended — indistinguishable from a healthy stream closing, and so a reconnect loop. The
 * `ApiError` thrown instead carries the response's own status, not 401, so nothing downstream
 * mistakes it for an expired token.
 *
 * `signal` aborts the request and, with it, the body the caller is reading.
 */
export async function openMeetingFileEvents(
  token: string,
  meetingId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Response> {
  const path = `/meetings/${meetingId}/files/events`;
  const response = await fetch(buildApiUrl(path), {
    headers: { ...authHeaders(token), accept: 'text/event-stream' },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response, path));
  }

  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    // Nothing is going to read this body, and a stream left open holds a connection.
    await response.body?.cancel();
    throw new ApiError(response.status, NOT_AN_EVENT_STREAM_MESSAGE);
  }

  return response;
}

/**
 * Sends a `failed` file back through the pipeline. The answer is the file as `uploaded`, so
 * the row goes back to Processing and the list's poll picks it up again. A 409 means it is no
 * longer failed — someone else retried it, or the worker finished it — and a 404 means the
 * caller is neither uploader nor host.
 */
export function retryMeetingFile(
  token: string,
  meetingId: string,
  fileId: string,
): Promise<MeetingFile> {
  return apiFetch<MeetingFile>(`/meetings/${meetingId}/files/${fileId}/retry`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

/** Soft delete. A 404 means the file is gone, or the caller is neither uploader nor host. */
export function deleteMeetingFile(token: string, meetingId: string, fileId: string): Promise<void> {
  return apiFetch<void>(`/meetings/${meetingId}/files/${fileId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}

/**
 * The original bytes. A `Blob` rather than a URL: the token lives in `localStorage` and cannot
 * ride on a plain `<a href>`, so the caller turns this into an object URL and clicks it.
 */
export function downloadMeetingFile(
  token: string,
  meetingId: string,
  fileId: string,
): Promise<Blob> {
  return apiFetchBlob(`/meetings/${meetingId}/files/${fileId}/content`, {
    headers: authHeaders(token),
  });
}

/** The WebP thumbnail, for the same reason as a `Blob`: an `<img src>` cannot carry the token. */
export function fetchThumbnail(token: string, meetingId: string, fileId: string): Promise<Blob> {
  return apiFetchBlob(`/meetings/${meetingId}/files/${fileId}/thumbnail`, {
    headers: authHeaders(token),
  });
}

/**
 * One file as `multipart/form-data`, field `file`.
 *
 * The only non-`fetch` call in this module, and deliberately so: `fetch` cannot report upload
 * progress, and the PRD asks for a percentage when the browser can give one. Everything else
 * about it matches `apiFetch` — the token as the first argument, `ApiError` with the API's
 * own message on a non-2xx, and the URL from `buildApiUrl`.
 */
export function uploadMeetingFile(
  token: string,
  meetingId: string,
  file: File,
  options: UploadOptions = {},
  createXhr: XhrFactory = () => new XMLHttpRequest(),
): Promise<MeetingFile> {
  const body = new FormData();
  body.append('file', file, file.name);

  return sendWithProgress<MeetingFile>(
    { method: 'POST', path: `/meetings/${meetingId}/files`, token, body },
    options,
    createXhr,
  );
}
