import type { MeetingDigest } from '@repo/shared';

import { apiFetch, authHeaders } from './core';

/**
 * A meeting's digest as it stands now, for anyone who can see the meeting.
 *
 * **A meeting with no digest is not an error**: it answers 200 with `version: 0` and neither
 * a status nor content, so a caller reads one shape. The 404 is "you cannot see this
 * meeting", the same one the meeting itself gets.
 */
export function fetchMeetingDigest(token: string, meetingId: string): Promise<MeetingDigest> {
  return apiFetch<MeetingDigest>(`/meetings/${meetingId}/digest`, {
    headers: authHeaders(token),
  });
}

/**
 * Asks for a digest that failed to be generated again: the request behind "Retry", and the
 * only one a page makes for a digest — every other one is generated with nobody asking. It
 * carries no body. The answer is the digest as the request left it — `queued`.
 *
 * A 409 means there is nothing to retry any more — a generation is under way, the digest
 * has not failed or is already replaced, there is no transcribed recording left, or the
 * setting is off — and its message is not page copy: a caller fetches the digest again and
 * shows that.
 * A 404 means the caller is neither the host nor the uploader of a transcribed recording.
 */
export function requestMeetingDigest(token: string, meetingId: string): Promise<MeetingDigest> {
  return apiFetch<MeetingDigest>(`/meetings/${meetingId}/digest/generation`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}
