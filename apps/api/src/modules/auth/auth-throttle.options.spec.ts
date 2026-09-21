import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';

import { authThrottlerOptions, tooManyAttemptsMessage } from './auth-throttle.options';

describe('tooManyAttemptsMessage', () => {
  it.each([
    [1, 'Too many attempts. Try again in 1 second.'],
    [45, 'Too many attempts. Try again in 45 seconds.'],
    [60, 'Too many attempts. Try again in 1 minute.'],
    // Rounded up: "1 minute" with 61 seconds left would be refused again for believing it.
    [61, 'Too many attempts. Try again in 2 minutes.'],
    [3600, 'Too many attempts. Try again in 60 minutes.'],
  ])('names a wait of %i seconds', (seconds, expected) => {
    expect(tooManyAttemptsMessage(seconds)).toBe(expected);
  });

  it('never tells a blocked caller to wait no time at all', () => {
    expect(tooManyAttemptsMessage(0)).toBe('Too many attempts. Try again in 1 second.');
  });
});

describe('authThrottlerOptions', () => {
  const context = {} as ExecutionContext;
  const options = authThrottlerOptions(300, 10);

  it('states the window in milliseconds, which is what the throttler counts in', () => {
    expect(options).toMatchObject({ throttlers: [{ ttl: 300_000, limit: 10 }] });
  });

  it('words the 429 from the wait the guard also sends as Retry-After', () => {
    const { errorMessage } = options as {
      errorMessage: (context: ExecutionContext, detail: ThrottlerLimitDetail) => string;
    };

    expect(errorMessage(context, { timeToBlockExpire: 90 } as ThrottlerLimitDetail)).toBe(
      tooManyAttemptsMessage(90),
    );
  });

  it('keys the counter on the caller alone, so every credential route shares one budget', () => {
    const { generateKey } = options as {
      generateKey: (context: ExecutionContext, tracker: string, throttlerName: string) => string;
    };
    const loginContext = { getHandler: () => 'login' } as unknown as ExecutionContext;
    const registerContext = { getHandler: () => 'register' } as unknown as ExecutionContext;

    expect(generateKey(loginContext, '203.0.113.7', 'default')).toBe(
      generateKey(registerContext, '203.0.113.7', 'default'),
    );
    expect(generateKey(loginContext, '203.0.113.7', 'default')).not.toBe(
      generateKey(loginContext, '203.0.113.8', 'default'),
    );
  });
});
