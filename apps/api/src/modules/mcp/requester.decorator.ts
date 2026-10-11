import { ExecutionContext, UnauthorizedException, createParamDecorator } from '@nestjs/common';

import type { McpRequester } from '../mcp-registry/mcp-scope';
import type { McpRequest } from './mcp-auth.guard';

/**
 * The requester `McpAuthGuard` left on the request. It throws rather than hand a handler
 * nobody when the guard did not run, as `@CurrentUser` does: a route that forgets
 * `@UseGuards` fails loudly instead of building a server for no one.
 */
export const Requester = createParamDecorator(
  (_data: unknown, context: ExecutionContext): McpRequester => {
    const { requester } = context.switchToHttp().getRequest<McpRequest>();

    if (requester === undefined) {
      throw new UnauthorizedException();
    }

    return requester;
  },
);
