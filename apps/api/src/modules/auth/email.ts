import { TransformFnParams } from 'class-transformer';

/**
 * Trims and lowercases, so an account is reachable however its owner capitalises the
 * address and the unique index enforces one account per person.
 *
 * Non-strings pass through untouched, on purpose: `@IsString()` should reject them. Coercing
 * here would turn a malformed request into a valid one.
 */
export function normaliseEmail({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * Everything before the last `@` of an already-normalised address, verbatim — so
 * `ada+test@example.com` yields `ada+test`, not `ada`.
 */
export function displayNameFromEmail(email: string): string {
  const separator = email.lastIndexOf('@');

  return separator === -1 ? email : email.slice(0, separator);
}
