import { ConflictException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import type { User } from '@repo/shared';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { displayNameFromEmail, toPublicUser } from '../../services/user.mapper';
import { CreateUserCommand } from '../create-user.command';

@CommandHandler(CreateUserCommand)
export class CreateUserHandler implements ICommandHandler<CreateUserCommand, User> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ email, passwordHash }: CreateUserCommand): Promise<User> {
    try {
      const user = await this.prisma.user.create({
        data: { email, passwordHash, displayName: displayNameFromEmail(email) },
      });

      return toPublicUser(user);
    } catch (error) {
      // The unique index decides, not a preceding read: two concurrent registrations of the
      // same address both pass a `findUnique` check, and only one can survive the insert.
      //
      // The 409 is thrown from here rather than from the auth module that dispatched the
      // command, because this is where the insert — and therefore the only authoritative
      // answer about whether the address was taken — actually is.
      if (isUniqueViolation(error)) {
        throw new ConflictException('That email is already registered');
      }

      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
