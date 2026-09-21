import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerLimitDetail, ThrottlerModuleOptions } from '@nestjs/throttler';

/** The throttler counts in milliseconds; the environment contract states a window in seconds,
 *  because every other duration in it is in seconds. */
const MILLISECONDS_PER_SECOND = 1000;

const SECONDS_PER_MINUTE = 60;

/**
 * Shown on a 429, naming the wait the throttler computed — the number it also sends as
 * `Retry-After`, so the sentence and the header cannot disagree. A fixed "wait a minute" is wrong
 * the moment `AUTH_RATE_LIMIT_WINDOW_SECONDS` is anything but sixty, and Nest's own
 * `ThrottlerException` message is the class name, which is not a sentence to put in front of
 * somebody who mistyped their password twice.
 *
 * Under a minute it counts seconds; from a minute up it counts whole minutes, rounded up, because
 * a person told "1 minute" when 61 seconds remain is refused again for believing it.
 */
export function tooManyAttemptsMessage(secondsToWait: number): string {
  return `Too many attempts. Try again in ${describeWait(secondsToWait)}.`;
}

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
    errorMessage: (
      _context: ExecutionContext,
      { timeToBlockExpire }: ThrottlerLimitDetail,
    ): string => tooManyAttemptsMessage(timeToBlockExpire),
    generateKey: (_context: ExecutionContext, tracker: string, throttlerName: string): string =>
      `${throttlerName}-auth-${tracker}`,
    throttlers: [{ ttl: windowSeconds * MILLISECONDS_PER_SECOND, limit: attempts }],
  };
}

/** Never "0 seconds": a blocked caller always has something left to wait. */
function describeWait(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) {
    return countOf(Math.max(seconds, 1), 'second');
  }

  return countOf(Math.ceil(seconds / SECONDS_PER_MINUTE), 'minute');
}

function countOf(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}
