import type { UpdateDisplayNameRequest, User } from '@repo/shared';

import { apiFetch, authHeaders } from './core';

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
