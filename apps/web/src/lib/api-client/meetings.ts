import type { Meeting, MeetingsCount, MeetingsOrder } from '@repo/shared';

import { apiFetch, authHeaders } from './core';

/** What `GET /meetings` can be asked for. Without either, it answers every meeting, ascending. */
export interface MeetingsQuery {
  /** At most this many — the API refuses more than `MAX_MEETINGS_LIMIT`. */
  limit?: number;
  order?: MeetingsOrder;
}

/**
 * The meetings the user hosts or attends, by `scheduledAt`: every one of them ascending unless
 * the query narrows it. `order` flips the direction and `limit` keeps the first so many; a tie
 * breaks on `id` ascending either way. Narrowing further — the latest few for a page — is
 * still the caller's job; see `src/lib/meetings.ts`.
 *
 * Returned as a `ReadonlyArray` although the API's own type is an array: the caller holds this
 * in React state, and the readonly type makes an in-place `.sort()` a compile error.
 */
export function listMeetings(
  token: string,
  query: MeetingsQuery = {},
): Promise<ReadonlyArray<Meeting>> {
  return apiFetch<Meeting[]>(`/meetings${searchOf(query)}`, { headers: authHeaders(token) });
}

/** How many meetings the user hosts or attends — the number a limited list no longer carries. */
export async function countMeetings(token: string): Promise<number> {
  const { total } = await apiFetch<MeetingsCount>('/meetings/count', {
    headers: authHeaders(token),
  });

  return total;
}

/** One meeting the user hosts or attends. A 404 covers both "no such meeting" and "not yours". */
export function getMeeting(token: string, meetingId: string): Promise<Meeting> {
  return apiFetch<Meeting>(`/meetings/${meetingId}`, { headers: authHeaders(token) });
}

/** `?order=…&limit=…` for what the query sets, and nothing at all for an empty one. */
function searchOf({ limit, order }: MeetingsQuery): string {
  const params = new URLSearchParams();

  if (order !== undefined) {
    params.set('order', order);
  }

  if (limit !== undefined) {
    params.set('limit', String(limit));
  }

  const search = params.toString();

  return search === '' ? '' : `?${search}`;
}
