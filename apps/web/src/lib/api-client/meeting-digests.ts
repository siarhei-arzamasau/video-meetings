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
