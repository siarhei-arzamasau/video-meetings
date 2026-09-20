import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import {
  DISPLAY_NAME_MESSAGE,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
  type User,
} from '@repo/shared';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { toPublicUser } from '../../services/user.mapper';
import { UpdateDisplayNameCommand } from '../update-display-name.command';

@CommandHandler(UpdateDisplayNameCommand)
export class UpdateDisplayNameHandler implements ICommandHandler<UpdateDisplayNameCommand, User> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ userId, displayName }: UpdateDisplayNameCommand): Promise<User> {
    // Trim first, then measure: the bounds are about the name that will be stored, and a
    // name of nothing but spaces is a blank name however many of them there are.
    const name = displayName.trim();

    if (name.length < MIN_DISPLAY_NAME_LENGTH || name.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new BadRequestException(DISPLAY_NAME_MESSAGE);
    }

    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: { displayName: name },
      });

      return toPublicUser(user);
    } catch (error) {
      // The guard loaded this row moments ago, so a miss here means the account was deleted
      // mid-request. That is the guard's own rule — a valid token must not outlive its
      // account — arriving one step later, and it answers the same way rather than as a 500.
      if (isRecordNotFound(error)) {
        throw new UnauthorizedException();
      }

      throw error;
    }
  }
}

function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
