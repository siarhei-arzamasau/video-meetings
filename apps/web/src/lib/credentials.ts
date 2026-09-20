import {
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_UNCHANGED_MESSAGE,
} from '@repo/shared';

/**
 * Deliberately looser than the API's `@IsEmail()`. Being stricter than the server is the
 * failure that matters — it rejects an address the API would have accepted, and the user has
 * no way to appeal. Catching the typos (missing `@`, missing domain) is all this is for.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The message to show for `email`, or `null` when it passes.
 *
 * Every rule here has a counterpart in `RegisterDto`, so a value this accepts should reach the
 * API without a 400. The reverse is not guaranteed and does not need to be: the server has the
 * final say, and `register` surfaces whatever it says.
 */
export function validateEmail(email: string): string | null {
  const trimmed = email.trim();

  if (trimmed === '') {
    return 'Enter your email address.';
  }

  if (trimmed.length > MAX_EMAIL_LENGTH) {
    return `Email addresses cannot be longer than ${String(MAX_EMAIL_LENGTH)} characters.`;
  }

  if (!EMAIL_PATTERN.test(trimmed)) {
    return 'Enter a valid email address, like you@example.com.';
  }

  return null;
}

/** The message to show for `password`, or `null` when it passes. */
export function validatePassword(password: string): string | null {
  if (password === '') {
    return 'Choose a password.';
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`;
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Passwords cannot be longer than ${String(MAX_PASSWORD_LENGTH)} characters.`;
  }

  // Length alone would accept eight spaces, which is what the API's `@Matches(/\S/)` is for.
  if (!/\S/.test(password)) {
    return 'Use at least one character that is not a space.';
  }

  return null;
}

/**
 * The message to show for `password` **on the sign-in form**, or `null` when it passes.
 *
 * No minimum length, which is not an oversight: `LoginDto` has none either. Login must accept
 * whatever registration once accepted, so an account whose password predates the current
 * minimum can still be signed into. Applying `validatePassword` here would reject that
 * password in the browser, and its owner would have no way to appeal a rule the server was
 * never going to enforce.
 *
 * The ceiling stays, because it bounds hashing work rather than stating a policy.
 */
export function validateLoginPassword(password: string): string | null {
  if (password === '') {
    return 'Enter your password.';
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Passwords cannot be longer than ${String(MAX_PASSWORD_LENGTH)} characters.`;
  }

  return null;
}

/**
 * Trimmed and lowercased, matching the API's `normaliseEmail`.
 *
 * Sending the raw value would work — the server normalises either way — but then the address
 * echoed back on the confirmation screen would not be the one the account was created under.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The message to show for the **new** password on the change-password form, or `null` when it
 * passes.
 *
 * `validatePassword` plus the one rule registration has no use for: a new password equal to
 * the current one is a change that changes nothing, and the API answers it with
 * `PASSWORD_UNCHANGED_MESSAGE`. Checking it here saves a round trip and nothing more — the
 * server still has the final say, as it does for every other rule in this file.
 *
 * `currentPassword` is compared verbatim, never trimmed: a password is the bytes the user
 * typed, and the API compares them the same way.
 */
export function validateNewPassword(newPassword: string, currentPassword: string): string | null {
  const failure = validatePassword(newPassword);

  if (failure !== null) {
    return failure;
  }

  // Only once there is something to compare against. An empty current-password field is that
  // field's problem, and saying "your new password must be different" about a blank one would
  // point the reader at the wrong input.
  if (currentPassword !== '' && newPassword === currentPassword) {
    return PASSWORD_UNCHANGED_MESSAGE;
  }

  return null;
}

/**
 * The message to show for the confirmation field, or `null` when it matches.
 *
 * The confirmation is never sent: the API has nothing to compare it against that the browser
 * did not already have, so this is the one rule in this file with no counterpart on the
 * server.
 */
export function validatePasswordConfirmation(
  confirmation: string,
  newPassword: string,
): string | null {
  if (confirmation === '') {
    return 'Repeat your new password.';
  }

  return confirmation === newPassword ? null : PASSWORD_MISMATCH_MESSAGE;
}
