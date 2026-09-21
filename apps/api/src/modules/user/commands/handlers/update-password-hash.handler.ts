import { UnauthorizedException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import { isRecordNotFound } from '../../../prisma/prisma-errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { UpdatePasswordHashCommand } from '../update-password-hash.command';

@CommandHandler(UpdatePasswordHashCommand)
export class UpdatePasswordHashHandler implements ICommandHandler<UpdatePasswordHashCommand, void> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ userId, passwordHash }: UpdatePasswordHashCommand): Promise<void> {
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    } catch (error) {
      // As in `UpdateDisplayNameHandler`: the guard loaded this row moments ago, so a miss
      // means the account was deleted mid-request. The guard's rule — a valid token must not
      // outlive its account — arriving one step later, answered the same way rather than as
      // a 500.
      if (isRecordNotFound(error)) {
        throw new UnauthorizedException();
      }

      throw error;
    }
  }
}
