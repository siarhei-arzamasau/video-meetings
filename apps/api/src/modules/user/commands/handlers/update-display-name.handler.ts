import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DISPLAY_NAME_MESSAGE, isDisplayNameWithinBounds, type User } from '@repo/shared';

import { isRecordNotFound } from '../../../prisma/prisma-errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { toPublicUser } from '../../services/user.mapper';
import { UpdateDisplayNameCommand } from '../update-display-name.command';

@CommandHandler(UpdateDisplayNameCommand)
export class UpdateDisplayNameHandler implements ICommandHandler<UpdateDisplayNameCommand, User> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ userId, displayName }: UpdateDisplayNameCommand): Promise<User> {
    // The shared predicate trims before it measures, in code points — the rule the DTO and
    // the browser apply, so a name one of them accepts is never refused here as too long.
    if (!isDisplayNameWithinBounds(displayName)) {
      throw new BadRequestException(DISPLAY_NAME_MESSAGE);
    }

    const name = displayName.trim();

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
