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
