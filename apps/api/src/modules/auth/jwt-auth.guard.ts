import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest, toPublicUser } from './authenticated-request';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Requires a `Bearer` token that verifies and still names an existing user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request.headers.authorization);

    if (token === undefined) {
      throw new UnauthorizedException();
    }

    const user = await this.prisma.user.findUnique({ where: { id: await this.subjectOf(token) } });

    if (user === null) {
      // The signature was good but the account is gone. A valid token must not outlive it.
      throw new UnauthorizedException();
    }

    (request as AuthenticatedRequest).user = toPublicUser(user);

    return true;
  }

  private async subjectOf(token: string): Promise<string> {
    let payload: { sub?: unknown };

    try {
      // `algorithms` is the load-bearing option. Left off, the verifier trusts the token's
      // own `alg` header, so an `alg: none` token with an empty signature is accepted and
      // anyone can mint a session as any user.
      payload = await this.jwt.verifyAsync<{ sub?: unknown }>(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException();
    }

    const { sub } = payload;

    // `id` is a uuid column: a non-uuid subject makes Postgres raise rather than simply
    // not match, which would surface as a 500 instead of a 401.
    if (typeof sub !== 'string' || !UUID_PATTERN.test(sub)) {
      throw new UnauthorizedException();
    }

    return sub;
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  const [scheme, value, ...rest] = header.split(' ');

  if (scheme !== 'Bearer' || value === undefined || value.length === 0 || rest.length > 0) {
    return undefined;
  }

  return value;
}
