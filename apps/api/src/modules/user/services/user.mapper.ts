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
  avatarKey: string | null;
  avatarVersion: number;
  createdAt: Date;
}): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    // The key never leaves this layer — it is a path on the server's disk, and a client that
    // knew it would be a client that could be tempted to ask for one. What crosses is the
    // route that serves the bytes, and only when there are bytes to serve: its absence is how
    // a client knows to draw initials.
    ...(user.avatarKey !== null ? { avatarPath: AVATAR_PATH } : {}),
    avatarVersion: user.avatarVersion,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Where the caller's own avatar is served from. A literal `me`, like every other route in
 * this module: the caller comes from the token.
 *
 * It is a constant rather than a function of the user id, and that is what makes
 * `avatarVersion` necessary — the path for one person never changes, so nothing about the URL
 * says the image behind it did. Exposing another user's avatar later means a second route
 * (`/users/:userId/avatar`) and this function taking an id; nothing here forecloses that.
 */
const AVATAR_PATH = '/users/me/avatar';

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
