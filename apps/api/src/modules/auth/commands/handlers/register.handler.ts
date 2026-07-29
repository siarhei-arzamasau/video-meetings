import { ConflictException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import type { AuthResponse } from '@repo/shared';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { displayNameFromEmail } from '../../email';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { RegisterCommand } from '../register.command';

@CommandHandler(RegisterCommand)
export class RegisterHandler implements ICommandHandler<RegisterCommand, AuthResponse> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async execute({ email, password }: RegisterCommand): Promise<AuthResponse> {
    const passwordHash = await this.passwords.hash(password);

    try {
      const user = await this.prisma.user.create({
        data: { email, passwordHash, displayName: displayNameFromEmail(email) },
      });

      return await this.tokens.issueToken(user.id);
    } catch (error) {
      // The unique index decides, not a preceding read: two concurrent registrations of the
      // same address both pass a `findUnique` check, and only one can survive the insert.
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
