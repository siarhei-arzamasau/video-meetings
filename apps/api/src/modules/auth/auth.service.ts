import { randomUUID } from 'node:crypto';

import { ConflictException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import type { AuthResponse, Credentials } from '@repo/shared';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { displayNameFromEmail } from './email';

/**
 * One message for every login failure. A distinct "no such user" would turn this endpoint
 * into an account-enumeration oracle.
 */
const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Verified against when no account matches, so a miss costs the same as a hit. Without
    // it, argon2 runs only on the hit path and response time leaks which emails exist —
    // the enumeration the shared error message is there to prevent.
    this.dummyHash = await hash(randomUUID());
  }

  async register({ email, password }: Credentials): Promise<AuthResponse> {
    const passwordHash = await hash(password);

    try {
      const user = await this.prisma.user.create({
        data: { email, passwordHash, displayName: displayNameFromEmail(email) },
      });

      return await this.issueToken(user.id);
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
      await verifyQuietly(this.dummyHash, password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!(await verifyQuietly(user.passwordHash, password))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.issueToken(user.id);
  }

  /** The token is the whole response; `sub` is the only claim this API puts in it. */
  private async issueToken(userId: string): Promise<AuthResponse> {
    return { accessToken: await this.jwt.signAsync({ sub: userId }) };
  }
}

/** argon2 raises on a malformed hash, which for a login attempt just means "no". */
async function verifyQuietly(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
