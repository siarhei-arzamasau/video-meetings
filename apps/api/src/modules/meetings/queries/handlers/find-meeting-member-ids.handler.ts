import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { PrismaService } from '../../../prisma/prisma.service';
import { FindMeetingMemberIdsQuery } from '../find-meeting-member-ids.query';

/**
 * The host and the participants, as ids. A host cannot be a participant of their own
 * meeting — `CreateMeetingHandler` refuses it — and the ids are made distinct all the same:
 * a caller that counts how many members a name identifies must never count one twice.
 */
@QueryHandler(FindMeetingMemberIdsQuery)
export class FindMeetingMemberIdsHandler implements IQueryHandler<
  FindMeetingMemberIdsQuery,
  string[] | null
> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ meetingId }: FindMeetingMemberIdsQuery): Promise<string[] | null> {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { hostId: true, participants: { select: { userId: true } } },
    });

    if (meeting === null) {
      return null;
    }

    return [...new Set([meeting.hostId, ...meeting.participants.map(({ userId }) => userId)])];
  }
}
