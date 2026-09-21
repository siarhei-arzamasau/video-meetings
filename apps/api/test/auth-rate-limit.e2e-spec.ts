import { ThrottlerStorageService, getOptionsToken, getStorageToken } from '@nestjs/throttler';

import {
  TOO_MANY_ATTEMPTS_MESSAGE,
  authThrottlerOptions,
} from '../src/modules/auth/auth-throttle.options';
import {
  CHANGE_PASSWORD_URL,
  EMAIL,
  LOGIN_URL,
  ME_URL,
  PASSWORD,
  REGISTER_URL,
} from './utils/fixtures';
import { accessTokenOf, messageOf } from './utils/http';
import { useApiSuite } from './utils/api-suite';

/**
 * A budget small enough to spend in a test, over a window long enough that no request in this
 * file expires before the file ends.
 *
 * Both matter. The run's real budget (`test/setup-env.ts`) is deliberately unreachable, so a
 * 429 has to come from options of this file's own — the throttler reads them once, at module
 * init, which is why this overrides the provider rather than setting an environment variable
 * the app has already read. And the window is a minute because the counter is cleared between
 * tests by hand: an expiry firing mid-file would decrement a count belonging to a later test.
 */
const ATTEMPTS = 3;
const WINDOW_SECONDS = 60;

const WRONG_PASSWORD = 'wrong-password-99';

describe('the /api/auth rate limit', () => {
  const suite = useApiSuite({
    overrides: [
      // Production's own options, narrowed to a budget a test can spend: the message and the
      // key strategy under test are the deployed ones, not a copy that could drift from them.
      { token: getOptionsToken(), value: authThrottlerOptions(WINDOW_SECONDS, ATTEMPTS) },
    ],
  });

  const login = (password: string) => suite.post(LOGIN_URL, { email: EMAIL, password });

  /** Every request in the file arrives from one address, so the counter is one number. */
  const resetBudget = (): void => {
    suite.app().get<ThrottlerStorageService>(getStorageToken()).storage.clear();
  };

  /**
   * A reduce rather than a loop with an await in it: the attempts must land one after another,
   * which is what the workspace's no-await-in-loop rule steers towards — and here it is also
   * the behaviour under test, since a parallel burst would leave which request is the one past
   * the budget up to the scheduler. `assemble` in meeting-files takes this shape for the first
   * reason alone.
   */
  const spendBudget = (): Promise<void> =>
    Array.from({ length: ATTEMPTS }).reduce<Promise<void>>(async (previous) => {
      await previous;
      await login(WRONG_PASSWORD).expect(401);
    }, Promise.resolve());

  let token: string;

  beforeEach(async () => {
    // Twice, and both are load-bearing. `truncateUsers` empties the database between tests but
    // not the counter, so the first reset hands back what the test before spent — without it
    // the seeding below is itself refused. The second covers the seeding's own attempt, so
    // every test starts from a whole budget.
    resetBudget();

    const registered = await suite.post(REGISTER_URL, { email: EMAIL, password: PASSWORD });

    token = accessTokenOf(registered);
    resetBudget();
  });

  it('answers the attempt past the budget with 429', async () => {
    await spendBudget();

    await login(WRONG_PASSWORD).expect(429);
  });

  it('spends the budget on wrong passwords, not only on requests that get somewhere', async () => {
    // The point of the limit: none of the attempts before the 429 authenticated anybody.
    await spendBudget();

    const blocked = await login(PASSWORD).expect(429);

    expect(blocked.body).toMatchObject({ statusCode: 429 });
    expect(messageOf(blocked)).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
  });

  it('tells the caller when to come back', async () => {
    await spendBudget();

    const blocked = await login(WRONG_PASSWORD).expect(429);

    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts register, login and the password change against one budget', async () => {
    // One budget per client, not one per route — otherwise the limit is three times what it
    // says, and an attacker just rotates endpoints.
    await suite.post(REGISTER_URL, { email: 'second@example.com', password: PASSWORD }).expect(201);
    await login(WRONG_PASSWORD).expect(401);
    await suite
      .patch(CHANGE_PASSWORD_URL, { currentPassword: WRONG_PASSWORD, newPassword: PASSWORD })
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    await login(WRONG_PASSWORD).expect(429);
  });

  it('leaves the session check outside the budget', async () => {
    // `me` gates every page the web app renders. Inside the budget, a person clicking around
    // would spend a limit meant for password attempts and be signed out of their own account.
    await spendBudget();
    await login(WRONG_PASSWORD).expect(429);

    await suite.get(ME_URL).set('Authorization', `Bearer ${token}`).expect(200);
  });
});
