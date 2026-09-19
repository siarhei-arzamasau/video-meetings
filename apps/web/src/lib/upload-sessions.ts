const PREFIX = 'video-meetings.upload-session.';

/**
 * Where a chunked upload's session id lives between page loads, keyed by the file's
 * fingerprint.
 *
 * This is the only part of resume that has to survive a reload. A browser cannot keep a `File`
 * handle across one, so the user picks the file again; this is what lets the client recognise
 * it and ask the server which chunks it already has, instead of re-sending a gigabyte.
 *
 * A remembered id is a hint, never a promise: the server may have expired it, or the user may
 * have picked a different file with the same name and size. `uploadInChunks` checks and opens
 * a new session when it disagrees, which is why nothing here needs to expire an entry itself.
 *
 * Every access is guarded, as in `auth-token.ts`: `localStorage` is absent during server
 * rendering and throws where storage is disabled. Losing a session id costs a re-upload, which
 * is not worth failing an upload over, so nothing here rethrows.
 */
export function rememberUploadSession(fingerprint: string, uploadId: string): void {
  try {
    window.localStorage.setItem(PREFIX + fingerprint, uploadId);
  } catch {
    // Storage unavailable: the upload still works, it simply cannot be resumed after a reload.
  }
}

export function recallUploadSession(fingerprint: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + fingerprint);
  } catch {
    return null;
  }
}

/** Called when the session is over — completed or aborted — so a re-pick starts clean. */
export function forgetUploadSession(fingerprint: string): void {
  try {
    window.localStorage.removeItem(PREFIX + fingerprint);
  } catch {
    // Unreadable storage is already forgotten.
  }
}
