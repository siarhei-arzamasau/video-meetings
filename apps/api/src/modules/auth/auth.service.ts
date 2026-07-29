import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthResponse, Credentials } from '@repo/shared';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { displayNameFromEmail } from './email';
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

  async register({ email, password }: Credentials): Promise<AuthResponse> {
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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
