import type { User } from '@repo/shared';
import type { Request } from 'express';

/**
 * A request that `JwtAuthGuard` has already authenticated.
 *
 * The guard attaches whatever `FindUserByIdQuery` returned, so the absence of a
 * `passwordHash` here is the user module's guarantee rather than a promise this file makes.
 */
export interface AuthenticatedRequest extends Request {
  user?: User;
}
