import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TEST_AUTH_RATE_LIMIT_ATTEMPTS,
  TEST_AUTH_RATE_LIMIT_WINDOW_SECONDS,
  TEST_JWT_EXPIRES_IN_SECONDS,
  TEST_JWT_SECRET,
  TEST_WEB_ORIGIN,
} from './utils/fixtures';

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

/**
 * Uploads land in a directory created per run and removed at exit, so `test:e2e` never reads
 * or deletes real uploads. The worker is off: the worker spec drives it by hand through
 * `drain()`, which is what makes "the row is now ready" a deterministic assertion rather
 * than a race against a poll loop.
 */
const meetingFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-files-'));
process.env['MEETING_FILES_DIR'] = meetingFilesDir;
process.env['MEETING_FILES_WORKER_ENABLED'] = 'false';
/**
 * Five seconds — the shortest the environment contract allows — rather than the sixty a
 * deployment gets: the worker renews a lease every third of it, and a spec for the heartbeat
 * cannot wait twenty seconds for the first renewal. Safe for every other spec, because each
 * one that cares about a lease seeds `leased_until` itself.
 */
process.env['MEETING_FILES_LEASE_SECONDS'] = '5';

/**
 * A budget no spec can exhaust, over a window too short to accumulate one.
 *
 * Every auth request in a spec file shares one counter — one address, one in-process store,
 * and `beforeEach` truncates the database, not the throttler — so a deployment's ten a minute
 * would fail whichever test happened to run eleventh, in whichever file. A thousand a second
 * cannot be reached by a suite whose auth requests each spend an argon2id hash.
 *
 * `auth-rate-limit.e2e-spec.ts` is the one file that wants a reachable limit, and it overrides
 * the options rather than these: the throttler reads them at module init, long before a spec
 * runs.
 */
process.env['AUTH_RATE_LIMIT_WINDOW_SECONDS'] = String(TEST_AUTH_RATE_LIMIT_WINDOW_SECONDS);
process.env['AUTH_RATE_LIMIT_ATTEMPTS'] = String(TEST_AUTH_RATE_LIMIT_ATTEMPTS);

/**
 * The browser suite's web origin, which `start:e2e-web` allows too: set rather than left to the
 * development default, which follows whatever `WEB_PORT` the developer's shell happens to hold.
 */
process.env['CORS_ORIGINS'] = TEST_WEB_ORIGIN;
process.on('exit', () => fs.rmSync(meetingFilesDir, { recursive: true, force: true }));
