import { BadRequestException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import type { Meeting } from '@repo/shared';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PARTICIPANTS_INCLUDE, toMeeting } from '../../services/meeting.mapper';
import { CreateMeetingCommand } from '../create-meeting.command';

/**
 * `meetings.host_id` and `meeting_participants.user_id` both reference `users`, so the error
 * code alone does not say which one failed.
 */
const HOST_FOREIGN_KEY = 'meetings_host_id_fkey';

@CommandHandler(CreateMeetingCommand)
export class CreateMeetingHandler implements ICommandHandler<CreateMeetingCommand, Meeting> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({
    hostId,
    title,
    scheduledAt,
    participantIds,
  }: CreateMeetingCommand): Promise<Meeting> {
    // Hosting and attending are separate roles, so `participantIds` never repeats the host.
    // The DTO cannot enforce this — it never sees the host, who comes from the guard — which
    // makes it exactly the kind of use-case invariant a handler owns. Accepting it silently
    // would produce a meeting whose participant list contradicts its own `hostId`.
    if (participantIds.includes(hostId)) {
      throw new BadRequestException(
        'The host is already on the meeting and cannot be a participant',
      );
    }

    try {
      // Prisma runs a nested create in one transaction, so a rejected participant leaves no
      // half-built meeting behind.
      const meeting = await this.prisma.meeting.create({
        data: {
          title,
          scheduledAt: new Date(scheduledAt),
          hostId,
          participants: { create: participantIds.map((userId) => ({ userId })) },
        },
        include: PARTICIPANTS_INCLUDE,
      });

      return toMeeting(meeting);
    } catch (error) {
      if (isUnknownParticipant(error)) {
        throw new BadRequestException('Every participant must be a registered user');
      }

      throw error;
    }
  }
}

/**
 * A foreign-key violation that is the caller's fault.
 *
 * The host key failing is not: it means the account authenticated moments earlier was deleted
 * before this insert, which is a server-side race and belongs in a 500 rather than a 400
 * blaming a participant list that was fine. Anything else is an id in that list naming no
 * user, so an unrecognised `meta` shape stays a 400 — the common case keeps the honest answer.
 */
function isUnknownParticipant(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2003' &&
    !namesHostForeignKey(error.meta)
  );
}

/**
 * Searches the serialised `meta` rather than a known path.
 *
 * The driver adapter buries the constraint several levels down — today at
 * `meta.driverAdapterError.cause.constraint.index`, with the same name repeated in a prose
 * `originalMessage`. That path is Prisma's internal shape, not part of its public contract, so
 * reading it directly would break silently on an upgrade: the lookup would return `undefined`,
 * this would answer `false`, and a vanished host would quietly start reporting a 400 about
 * participants. Matching the whole payload survives the shape moving.
 */
function namesHostForeignKey(meta: unknown): boolean {
  if (meta === undefined) {
    return false;
  }

  try {
    return JSON.stringify(meta)?.includes(HOST_FOREIGN_KEY) ?? false;
  } catch {
    // A payload that will not serialise tells us nothing either way; fall back to the
    // overwhelmingly likelier cause.
    return false;
  }
}
