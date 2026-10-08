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
 * Asks for the meeting's digest to be generated now: the one request behind both "Generate
 * digest" and "Retry". Which of the two it was is the API's to say (`availableAction` on the
 * digest), so it carries no body. The answer is the digest as the request left it — `queued`.
 *
 * A 409 means there is nothing to ask for any more — a generation is under way, the digest
 * already covers every transcribed recording, there is no such recording, or the setting is
 * off — and its message is not page copy: a caller fetches the digest again and shows that.
 * A 404 means the caller is neither the host nor the uploader of a transcribed recording.
 */
export function requestMeetingDigest(token: string, meetingId: string): Promise<MeetingDigest> {
  return apiFetch<MeetingDigest>(`/meetings/${meetingId}/digest/generation`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}
