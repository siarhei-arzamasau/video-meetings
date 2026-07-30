import type { User } from './user';

export const MEETING_STATUSES = ['scheduled', 'live', 'ended'] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** A scheduled or in-progress video meeting. */
export interface Meeting {
  id: string;
  title: string;
  status: MeetingStatus;
  hostId: User['id'];
  /** ISO 8601 instant, always normalised to UTC. */
  scheduledAt: string;
  /** Attendees only — the host is named by `hostId` and never repeated here. */
  participantIds: ReadonlyArray<User['id']>;
}

/**
 * Body of `POST /api/meetings`.
 *
 * Field names match `Meeting` deliberately. The request and the response describe one
 * resource, and renaming across that boundary buys nothing but a mapping every caller has to
 * learn and keep straight. The fields the server owns — `id`, `status` — are simply absent.
 */
export interface CreateMeetingRequest {
  title: string;
  /** ISO 8601 instant. A bare calendar date is rejected; see the API's `CreateMeetingDto`. */
  scheduledAt: string;
  participantIds: ReadonlyArray<User['id']>;
}
