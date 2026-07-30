import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Meeting, MeetingStatus } from '@repo/shared';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMeetingDto } from './dto/create-meeting.dto';

const PARTICIPANTS_INCLUDE = {
  participants: {
    orderBy: { userId: 'asc' },
    select: { userId: true },
  },
} as const;

@Injectable()
export class MeetingsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(hostId: string, dto: CreateMeetingDto): Promise<Meeting> {
    try {
      const meeting = await this.prisma.meeting.create({
        data: {
          title: dto.title,
          scheduledAt: new Date(dto.date),
          hostId,
          participants: {
            create: dto.participants.map((userId) => ({ userId })),
          },
        },
        include: PARTICIPANTS_INCLUDE,
      });

      return toMeeting(meeting);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new BadRequestException('Every participant must be a registered user');
      }

      throw error;
    }
  }

  async findAll(userId: string): Promise<Meeting[]> {
    const meetings = await this.prisma.meeting.findMany({
      where: visibleTo(userId),
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
      throw new NotFoundException('Meeting not found');
    }

    return toMeeting(meeting);
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

function visibleTo(userId: string): {
  OR: Array<{ hostId: string } | { participants: { some: { userId: string } } }>;
} {
  return {
    OR: [{ hostId: userId }, { participants: { some: { userId } } }],
  };
}

function toMeeting(record: {
  id: string;
  title: string;
  status: MeetingStatus;
  hostId: string;
  scheduledAt: Date;
  participants: Array<{ userId: string }>;
}): Meeting {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    hostId: record.hostId,
    scheduledAt: record.scheduledAt.toISOString(),
    participantIds: record.participants.map(({ userId }) => userId),
  };
}
