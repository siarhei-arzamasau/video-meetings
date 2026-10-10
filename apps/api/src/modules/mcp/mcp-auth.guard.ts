import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { bearerTokenOf } from '../auth/bearer-token';
import { AccessTokenVerifier } from '../auth/services/access-token.verifier';
import type { McpRequester } from '../mcp-registry/mcp-scope';

/** A request `McpAuthGuard` has let through: who the MCP server is to answer. */
export interface McpRequest extends Request {
  requester?: McpRequester;
}

/**
 * The guard on `/api/mcp`: a `Bearer` access token, verified as every other route verifies
 * one — `AccessTokenVerifier`, the API's own key and nothing issued elsewhere — and the id
 * it names left on the request as `req.requester`.
 *
 * **Who is calling comes from the token's claims, and no user is read.** `JwtAuthGuard`
 * goes on to load the account and refuses a token that has outlived it; an MCP server
 * needs an id and nothing else of the user, so this guard reaches no database. A token of
 * an account that is gone therefore gets past it — and no further: the server is built
 * only for a meeting its requester can see, a participant's rows go with their account,
 * and a host's account cannot be deleted while it has a meeting. Such a caller is answered
 * as a stranger is, with a 404.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(private readonly tokens: AccessTokenVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<McpRequest>();
    const token = bearerTokenOf(request.headers.authorization);
    const userId = token === undefined ? null : await this.tokens.subjectOf(token);

    if (userId === null) {
      throw new UnauthorizedException();
    }

    request.requester = { userId };

    return true;
  }
}
