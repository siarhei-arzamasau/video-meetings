import type { User } from './user';

export const MEETING_STATUSES = ['scheduled', 'live', 'ended'] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** A scheduled or in-progress video meeting. */
export interface Meeting {
  id: string;
  title: string;
  status: MeetingStatus;
  hostId: User['id'];
  /** ISO 8601 timestamp. */
  scheduledAt: string;
  participantIds: ReadonlyArray<User['id']>;
}
