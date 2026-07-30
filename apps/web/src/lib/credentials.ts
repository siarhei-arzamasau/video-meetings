import { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@repo/shared';

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
 * Trimmed and lowercased, matching the API's `normaliseEmail`.
 *
 * Sending the raw value would work — the server normalises either way — but then the address
 * echoed back on the confirmation screen would not be the one the account was created under.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
