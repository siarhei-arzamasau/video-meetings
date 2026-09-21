import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { PrismaService } from '../../../prisma/prisma.service';
import { visibleTo } from '../../services/meeting.mapper';
import { FindVisibleMeetingQuery } from '../find-visible-meeting.query';
import type { VisibleMeeting } from '../find-visible-meeting.query';

/**
 * The visibility rule `MeetingsService.findOne` applies, selecting only the two columns a file
 * route decides with. No participants join: every file route runs this, and the chunk route
 * runs it twice per chunk — once before the body is read, once in the handler. Sharing
 * `visibleTo` with the service keeps the authorisation rule stated once; the in-module read
 * stays on the service, where the guide says in-module reads belong.
 */
@QueryHandler(FindVisibleMeetingQuery)
export class FindVisibleMeetingHandler implements IQueryHandler<
  FindVisibleMeetingQuery,
  VisibleMeeting | null
> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ userId, meetingId }: FindVisibleMeetingQuery): Promise<VisibleMeeting | null> {
    return this.prisma.meeting.findFirst({
      where: { id: meetingId, ...visibleTo(userId) },
      select: { id: true, hostId: true },
    });
  }
}
