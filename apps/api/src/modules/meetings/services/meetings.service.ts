import { Injectable, NotFoundException } from '@nestjs/common';
import type { Meeting } from '@repo/shared';

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

  async findAll(userId: string): Promise<Meeting[]> {
    const meetings = await this.prisma.meeting.findMany({
      where: visibleTo(userId),
      // `id` breaks ties: two meetings at the same instant would otherwise come back in
      // whatever order the planner chose, so a caller could not diff two identical responses.
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      include: PARTICIPANTS_INCLUDE,
    });

    return meetings.map(toMeeting);
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
