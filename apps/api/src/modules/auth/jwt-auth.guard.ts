import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { User } from '@repo/shared';
import type { Request } from 'express';

import { FindUserByIdQuery } from '../user/queries/find-user-by-id.query';
import { AuthenticatedRequest } from './authenticated-request';
import { bearerTokenOf } from './bearer-token';
import { AccessTokenVerifier } from './services/access-token.verifier';

/** Requires a `Bearer` token that verifies and still names an existing user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: AccessTokenVerifier,
    private readonly queryBus: QueryBus,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerTokenOf(request.headers.authorization);
    const userId = token === undefined ? null : await this.tokens.subjectOf(token);

    if (userId === null) {
      throw new UnauthorizedException();
    }

    // The query already returns the public shape, so what lands on the request cannot carry a
    // password hash — and this is the value `@CurrentUser` hands a controller, which is one
    // `res.json` away from a response body.
    const user = await this.queryBus.execute<FindUserByIdQuery, User | null>(
      new FindUserByIdQuery(userId),
    );

    if (user === null) {
      // The signature was good but the account is gone. A valid token must not outlive it.
      throw new UnauthorizedException();
    }

    (request as AuthenticatedRequest).user = user;

    return true;
  }
}
