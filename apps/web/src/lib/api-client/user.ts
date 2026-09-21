import type { UpdateDisplayNameRequest, User } from '@repo/shared';

import { apiFetch, apiFetchBlob, authHeaders } from './core';

/**
 * The `/users/me` endpoints: the account record itself, as opposed to the credentials and
 * tokens `auth.ts` covers. The API draws the same line — `user` owns the record, `auth` owns
 * the sign-in — so `getMe` living next door under `/auth/me` is the API's shape, not a
 * misfiling here.
 */

/**
 * Renames the caller. There is no user id to send: the endpoint acts on whoever the token
 * names, and one that took an id would be one that could be pointed at somebody else.
 *
 * `PATCH`, and the answer is the whole updated user — so a caller holding the signed-in user
 * in memory replaces it with this rather than following up with `getMe`.
 *
 * A 400 means the name broke a bound `validateDisplayName` did not catch first, and its
 * message is `DISPLAY_NAME_MESSAGE` — the same constant the form renders, so the sentence the
 * field shows is the same either way.
 */
export function updateDisplayName(token: string, displayName: string): Promise<User> {
  return apiFetch<User>('/users/me', {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ displayName } satisfies UpdateDisplayNameRequest),
  });
}

/**
 * Replaces the caller's avatar with one image, as `multipart/form-data`, field `avatar`.
 *
 * `fetch` rather than the `XMLHttpRequest` path `uploadMeetingFile` takes: that exists only
 * to report progress on a file that may be a hundred megabytes, and an avatar is capped at
 * five. No `content-type` is set — `apiFetch` leaves a `FormData` body to the browser, which
 * is the only thing that can produce the boundary.
 *
 * Answers with the whole updated user, so the caller replaces the signed-in user with this
 * rather than following up with `getMe`. Its `avatarVersion` is what makes the new picture
 * appear: the path never changes.
 */
export function uploadAvatar(token: string, file: File): Promise<User> {
  const body = new FormData();
  body.append('avatar', file, file.name);

  return apiFetch<User>('/users/me/avatar', {
    method: 'POST',
    headers: authHeaders(token),
    body,
  });
}

/**
 * The stored rendition as a `Blob`. It has to be fetched rather than pointed at, because an
 * `<img src>` cannot carry the bearer header — the same reason meeting-file thumbnails are
 * fetched this way.
 *
 * A 404 means the account has no avatar. Callers draw initials for it rather than treating it
 * as a failure.
 */
export function fetchAvatar(token: string): Promise<Blob> {
  return apiFetchBlob('/users/me/avatar', { headers: authHeaders(token) });
}

/**
 * Removes the caller's avatar and answers with the updated user, so the page that asked falls
 * back to initials without a second request. Idempotent on the server: an account with none
 * is a 200, not a 404.
 */
export function deleteAvatar(token: string): Promise<User> {
  return apiFetch<User>('/users/me/avatar', {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}
