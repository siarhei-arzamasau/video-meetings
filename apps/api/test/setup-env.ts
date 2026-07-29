import { TEST_JWT_EXPIRES_IN_SECONDS, TEST_JWT_SECRET } from './utils/fixtures';

/**
 * Jest `setupFiles` entry — this must run before anything imports `AppModule`.
 *
 * `ConfigModule.forRoot()` is evaluated when `app.module.ts` is *imported*, not when the
 * testing module is compiled, and it prefers `process.env` over the `.env` file. Setting the
 * secret any later means the app signs tokens with whatever is in the developer's local
 * `.env` while the tests verify against the test secret — every token assertion then fails
 * with a signature mismatch that looks like a bug in the signing code.
 */
process.env['JWT_SECRET'] = TEST_JWT_SECRET;
process.env['JWT_EXPIRES_IN_SECONDS'] = String(TEST_JWT_EXPIRES_IN_SECONDS);
