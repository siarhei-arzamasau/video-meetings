import { Injectable, NotFoundException } from '@nestjs/common';
import type { Meeting, MeetingsOrder } from '@repo/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { PARTICIPANTS_INCLUDE, toMeeting, visibleTo } from './meeting.mapper';

/**
 * The read side. Deliberately not a `QueryBus`: the command bus earns its indirection on
 * operations that change state, and routing a plain lookup through a bus for symmetry is how
 * this pattern turns into ceremony. Writes live in `commands/handlers/`.
 */
@Injectable()
export class MeetingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every meeting the user hosts or attends — or the first `limit` of them in `order`. */
  async findAll(
    userId: string,
    { limit, order = 'asc' }: { limit?: number; order?: MeetingsOrder } = {},
  ): Promise<Meeting[]> {
    const meetings = await this.prisma.meeting.findMany({
      where: visibleTo(userId),
      // `id` breaks ties: two meetings at the same instant would otherwise come back in
      // whatever order the planner chose, so a caller could not diff two identical responses.
      // Ascending in both orders, which is the tie-break the web app's own sort uses.
      orderBy: [{ scheduledAt: order }, { id: 'asc' }],
      take: limit,
      include: PARTICIPANTS_INCLUDE,
    });

    return meetings.map(toMeeting);
  }

  /** How many meetings the user hosts or attends, without reading any of them. */
  async count(userId: string): Promise<number> {
    return this.prisma.meeting.count({ where: visibleTo(userId) });
  }

  async findOne(userId: string, meetingId: string): Promise<Meeting> {
    const meeting = await this.prisma.meeting.findFirst({
      where: { id: meetingId, ...visibleTo(userId) },
      include: PARTICIPANTS_INCLUDE,
    });

    if (meeting === null) {
      // The same 404 whether the meeting is missing or simply not this user's. A 403 for the
      // second case would confirm that someone else's meeting exists at that id.
      throw new NotFoundException('Meeting not found');
    }

    return toMeeting(meeting);
  }
}
