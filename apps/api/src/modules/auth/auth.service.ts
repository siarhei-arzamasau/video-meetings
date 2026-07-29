import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthResponse, Credentials } from '@repo/shared';

import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';

/**
 * One message for every login failure. A distinct "no such user" would turn this endpoint
 * into an account-enumeration oracle.
 */
const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async login({ email, password }: Credentials): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user === null) {
      await this.passwords.verifyDummy(password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.tokens.issueToken(user.id);
  }
}
