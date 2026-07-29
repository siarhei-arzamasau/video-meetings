import { ExecutionContext, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { User } from '@repo/shared';

import { AuthenticatedRequest } from './authenticated-request';

/**
 * The user `JwtAuthGuard` attached to the request. Only meaningful on a route that guard
 * protects — it throws rather than returning undefined if the guard did not run, so a route
 * that forgets `@UseGuards` fails loudly instead of handing the handler no user.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (user === undefined) {
      throw new UnauthorizedException();
    }

    return user;
  },
);
