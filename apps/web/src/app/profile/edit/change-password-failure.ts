import { CURRENT_PASSWORD_MESSAGE } from '@repo/shared';

import { ApiError } from '@/lib/api-client';

/** The field a failure belongs on, or `null` when it belongs to the section as a whole. */
export type FailedField = 'currentPassword' | 'newPassword' | null;

/**
 * A 401 that means the token, rather than the password.
 *
 * `PATCH /auth/password` answers both with the same status — a wrong current password gets
 * login's shape on purpose — so the **sentence** is the discriminator.
 * `CURRENT_PASSWORD_MESSAGE` comes from `@repo/shared` and is the exact string the API sends,
 * which is what keeps the two from drifting apart: reword it and both sides move together.
 *
 * Getting this backwards is not a cosmetic bug. It signs a user out of the app because they
 * mistyped one field.
 */
export function isExpiredToken(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 401 && error.message !== CURRENT_PASSWORD_MESSAGE
  );
}

/**
 * Turns a thrown value into something to show, and decides where.
 *
 * A 401 that was not `isExpiredToken` is the current password being wrong, so it belongs on
 * that field — the one the user has to change. A 400 is the API applying a bound the
 * new-password field just checked, so it belongs on that one. Everything else belongs to the
 * section: a 500 or an unreachable API says nothing about either value.
 */
export function describeSaveFailure(error: unknown): { message: string; field: FailedField } {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return { message: error.message, field: 'currentPassword' };
    }

    return { message: error.message, field: error.status === 400 ? 'newPassword' : null };
  }

  // `fetch` rejects rather than resolving when the request never reached the API at all.
  return {
    message: 'We could not reach the server. Check your connection and try again.',
    field: null,
  };
}
