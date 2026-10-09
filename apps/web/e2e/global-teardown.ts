import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from 'dotenv';
import { Client } from 'pg';

/** The Prisma CLI's own fallback, and the API test helpers': the Compose database. */
const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/video_meetings';

/** The env files the API reads, the first to name a variable winning. */
const API_ENV_FILES = ['.env.local', '.env'];

/**
 * What marks the browser suite's database. **This restates `browserSuiteDatabaseUrl` in
 * `apps/api/test/utils/test-database.ts`**, which is what points the suite's API at it; this
 * file runs in another package and cannot import it. Change one and change the other.
 */
const BROWSER_SUITE_DATABASE_SUFFIX = '_web_test';

/** The database the suite's API ran against: the configured one's name with the suffix on. */
function browserSuiteDatabaseUrl(): string {
  const apiRoot = path.resolve(__dirname, '../../api');
  const fromFiles = API_ENV_FILES.map(
    (file) =>
      config({ path: path.join(apiRoot, file), processEnv: {}, quiet: true }).parsed?.[
        'DATABASE_URL'
      ],
  ).find((value) => value !== undefined && value !== '');
  const url = new URL(process.env['DATABASE_URL'] || fromFiles || DEFAULT_DATABASE_URL);
  const name = decodeURIComponent(url.pathname.slice(1));

  if (!name.endsWith(BROWSER_SUITE_DATABASE_SUFFIX)) {
    url.pathname = `/${encodeURIComponent(`${name}${BROWSER_SUITE_DATABASE_SUFFIX}`)}`;
  }

  return url.toString();
}

/**
 * Empties the suite's own database, mirroring `useApiSuite`'s `afterAll`.
 *
 * The suite runs in a separate process from the API, so it cannot call the API's raw-SQL
 * truncation helper; every test uses unique emails and its own meeting, so nothing here is
 * needed for correctness. `TRUNCATE ... CASCADE` follows the foreign keys to meetings,
 * participants, and files. The API's own temp storage directory goes the same way.
 *
 * **It refuses a database whose name does not end in `_web_test`, in the statement that would
 * empty it** — the whole of this suite's suffix, so not the API suite's `…_test` either. This
 * used to run against whatever `DATABASE_URL` named, which on a set-up machine is the
 * development database.
 */
export default async function globalTeardown(): Promise<void> {
  const client = new Client({ connectionString: browserSuiteDatabaseUrl() });

  await client.connect();

  try {
    await client.query(`
      DO $$
      BEGIN
        IF right(current_database(), ${String(BROWSER_SUITE_DATABASE_SUFFIX.length)}) <> '${BROWSER_SUITE_DATABASE_SUFFIX}' THEN
          RAISE EXCEPTION 'Refusing to truncate "%": not the browser suite''s database', current_database();
        END IF;

        TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;
      END
      $$;
    `);
  } finally {
    await client.end();
  }

  fs.rmSync(path.join(os.tmpdir(), 'meeting-files-e2e-web'), { recursive: true, force: true });
}
