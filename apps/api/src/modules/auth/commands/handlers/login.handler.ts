import { UnauthorizedException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import type { AuthResponse } from '@repo/shared';

import { PrismaService } from '../../../prisma/prisma.service';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { LoginCommand } from '../login.command';

/**
 * One message for every login failure. A distinct "no such user" would turn this endpoint
 * into an account-enumeration oracle.
 */
const INVALID_CREDENTIALS = 'Invalid email or password';

@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand, AuthResponse> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async execute({ email, password }: LoginCommand): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user === null) {
      // Costs what a real verification costs, so the response time does not reveal that
      // no account matched.
      await this.passwords.verifyDummy(password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.tokens.issueToken(user.id);
  }
}
