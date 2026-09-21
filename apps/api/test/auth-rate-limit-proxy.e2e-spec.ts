import { ThrottlerStorageService, getOptionsToken, getStorageToken } from '@nestjs/throttler';

import { authThrottlerOptions } from '../src/modules/auth/auth-throttle.options';
import { EMAIL, LOGIN_URL } from './utils/fixtures';
import { useApiSuite } from './utils/api-suite';

/**
 * The auth rate limit behind one reverse proxy: `TRUST_PROXY_HOPS=1`, what a deployment sets when
 * TLS is terminated in front of the API.
 *
 * A file of its own because the hop count is installed once, by `configureApp`, and
 * `auth-rate-limit.e2e-spec.ts` pins the default of zero. The budget is narrowed for the reason
 * given there: the run's own is deliberately out of reach.
 */
const ATTEMPTS = 3;
const WINDOW_SECONDS = 60;

/** Documentation addresses (RFC 5737): two people behind one proxy, and a made-up third. */
const FIRST_CLIENT = '203.0.113.7';
const SECOND_CLIENT = '203.0.113.8';
const SPOOFED_CLIENT = '198.51.100.23';

describe('the /api/auth rate limit behind a proxy', () => {
  const suite = useApiSuite({
    overrides: [
      { token: getOptionsToken(), value: authThrottlerOptions(WINDOW_SECONDS, ATTEMPTS) },
    ],
    config: { TRUST_PROXY_HOPS: 1 },
  });

  /**
   * A failed login as the proxy forwards it, the header ending with the address it saw. No
   * account is registered: an unknown address answers 401 exactly as a wrong password does, and
   * spends the budget the same.
   */
  const loginVia = (forwardedFor: string) =>
    suite
      .post(LOGIN_URL, { email: EMAIL, password: 'wrong-password-99' })
      .set('X-Forwarded-For', forwardedFor);

  /** One attempt after another, for the reason `auth-rate-limit.e2e-spec.ts` gives. */
  const spendBudgetOf = (client: string): Promise<void> =>
    Array.from({ length: ATTEMPTS }).reduce<Promise<void>>(async (previous) => {
      await previous;
      await loginVia(client).expect(401);
    }, Promise.resolve());

  beforeEach(() => {
    suite.app().get<ThrottlerStorageService>(getStorageToken()).storage.clear();
  });

  it('gives every client behind the proxy a budget of its own', async () => {
    // At zero hops these two are one caller — the proxy — and the second is refused with the
    // first: ten attempts a minute from anyone would lock everyone out.
    await spendBudgetOf(FIRST_CLIENT);
    await loginVia(FIRST_CLIENT).expect(429);

    await loginVia(SECOND_CLIENT).expect(401);
  });

  it('counts the address the proxy appended, not one the client wrote ahead of it', async () => {
    // The client sent its own `X-Forwarded-For`; the proxy appended the address it really saw.
    // One trusted hop reads the right-most entry, so the invented one changes nothing.
    await spendBudgetOf(FIRST_CLIENT);

    await loginVia(`${SPOOFED_CLIENT}, ${FIRST_CLIENT}`).expect(429);
  });
});
