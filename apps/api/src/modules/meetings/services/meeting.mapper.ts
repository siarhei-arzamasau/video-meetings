import type { Meeting, MeetingStatus } from '@repo/shared';

import { Prisma } from '../../../generated/prisma/client';

/**
 * Shared by the write and the read path so both return participants in one order. Sorting in
 * the database rather than in `toMeeting` keeps the order stable for any caller that streams
 * or paginates later.
 */
export const PARTICIPANTS_INCLUDE = {
  participants: {
    orderBy: { userId: 'asc' },
    select: { userId: true },
  },
} as const;

/** The shape `PARTICIPANTS_INCLUDE` produces, spelled out so `toMeeting` is unit-testable. */
export interface MeetingRecord {
  id: string;
  title: string;
  status: MeetingStatus;
  hostId: string;
  scheduledAt: Date;
  participants: Array<{ userId: string }>;
}

export function toMeeting(record: MeetingRecord): Meeting {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    hostId: record.hostId,
    scheduledAt: record.scheduledAt.toISOString(),
    participantIds: record.participants.map(({ userId }) => userId),
  };
}

/**
 * Every meeting the user may see: the ones they host and the ones they attend.
 *
 * This is the whole authorisation rule for reads, which is why it is one function rather than
 * a clause repeated per query — a list that filters and a lookup that does not would leak the
 * existence of other people's meetings through `GET /meetings/:id`.
 */
export function visibleTo(userId: string): Prisma.MeetingWhereInput {
  return {
    OR: [{ hostId: userId }, { participants: { some: { userId } } }],
  };
}
