import type { User } from '@repo/shared';
import type { Request } from 'express';

/** A request that `JwtAuthGuard` has already authenticated. */
export interface AuthenticatedRequest extends Request {
  user?: User;
}

/**
 * The API-facing shape of a user: camelCase, an ISO timestamp, and — the point of having
 * this function at all — no `passwordHash`. Stored rows never reach a response directly.
 */
export function toPublicUser(user: {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
}): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
  };
}
