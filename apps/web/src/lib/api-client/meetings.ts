import type { Meeting } from '@repo/shared';

import { apiFetch, authHeaders } from './core';

/**
 * Every meeting the user hosts or attends, ascending by `scheduledAt`.
 *
 * The endpoint takes no query parameters — no page, no filter, no sort — so this is the whole
 * list and narrowing it is the caller's job. See `src/lib/meetings.ts`.
 *
 * Returned as a `ReadonlyArray` although the API's own type is an array: the caller holds this
 * in React state, and the readonly type makes an in-place `.sort()` a compile error.
 */
export function listMeetings(token: string): Promise<ReadonlyArray<Meeting>> {
  return apiFetch<Meeting[]>('/meetings', { headers: authHeaders(token) });
}

/** One meeting the user hosts or attends. A 404 covers both "no such meeting" and "not yours". */
export function getMeeting(token: string, meetingId: string): Promise<Meeting> {
  return apiFetch<Meeting>(`/meetings/${meetingId}`, { headers: authHeaders(token) });
}
