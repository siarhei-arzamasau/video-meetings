import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import type { Meeting } from '@repo/shared';

import { PrismaService } from '../../../prisma/prisma.service';
import { PARTICIPANTS_INCLUDE, toMeeting, visibleTo } from '../../services/meeting.mapper';
import { FindVisibleMeetingQuery } from '../find-visible-meeting.query';

/**
 * `MeetingsService.findOne` minus the throw. Two near-identical reads is the accepted cost:
 * this handler exists because a read crosses a module boundary, and the in-module read stays
 * on the service, where the guide says in-module reads belong. Both share `visibleTo`, so the
 * authorisation rule is still stated once.
 */
@QueryHandler(FindVisibleMeetingQuery)
export class FindVisibleMeetingHandler implements IQueryHandler<
  FindVisibleMeetingQuery,
  Meeting | null
> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ userId, meetingId }: FindVisibleMeetingQuery): Promise<Meeting | null> {
    const meeting = await this.prisma.meeting.findFirst({
      where: { id: meetingId, ...visibleTo(userId) },
      include: PARTICIPANTS_INCLUDE,
    });

    return meeting === null ? null : toMeeting(meeting);
  }
}
