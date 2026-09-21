import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';

/** The throttler counts in milliseconds; the environment contract states a window in seconds,
 *  because every other duration in it is in seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Shown on a 429. Nest's own `ThrottlerException` message is the class name, which is not a
 * sentence to put in front of somebody who mistyped their password twice.
 */
export const TOO_MANY_ATTEMPTS_MESSAGE = 'Too many attempts. Wait a minute and try again.';

/**
 * One budget for every credential route, rather than the throttler's default.
 *
 * That default keys the counter on the handler as well as the caller, which would give
 * register, login, and the password change a separate allowance each — three times the limit
 * the environment contract states, collectable by an attacker who simply rotates endpoints.
 * Registering is as expensive as logging in, so the cost of the three is one cost and the
 * budget for them is one budget.
 *
 * `tracker` is the caller, and `auth` is what scopes the key to this module: a second
 * controller throttled from these options would share the allowance, which is why nothing
 * else uses them.
 */
export function authThrottlerOptions(
  windowSeconds: number,
  attempts: number,
): ThrottlerModuleOptions {
  return {
    errorMessage: TOO_MANY_ATTEMPTS_MESSAGE,
    generateKey: (_context: ExecutionContext, tracker: string, throttlerName: string): string =>
      `${throttlerName}-auth-${tracker}`,
    throttlers: [{ ttl: windowSeconds * MILLISECONDS_PER_SECOND, limit: attempts }],
  };
}
