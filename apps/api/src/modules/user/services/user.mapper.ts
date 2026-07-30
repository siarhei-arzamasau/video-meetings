import type { User } from '@repo/shared';

/**
 * The API-facing shape of a user: camelCase, an ISO timestamp, and — the point of having
 * this function at all — no `passwordHash`. Stored rows never reach a response directly.
 *
 * Every query that returns a user maps through this, which is what makes the omission a
 * property of the module rather than of each call site. A column added to the model is
 * invisible to callers until someone adds it here on purpose.
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

/**
 * Everything before the last `@` of an already-normalised address, verbatim — so
 * `ada+test@example.com` yields `ada+test`, not `ada`.
 *
 * Lives here rather than in auth: what a new account is called is a property of the user
 * record, not of the credentials that created it.
 */
export function displayNameFromEmail(email: string): string {
  const separator = email.lastIndexOf('@');

  return separator === -1 ? email : email.slice(0, separator);
}
