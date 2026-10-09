import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { config } from 'dotenv';
import { Client } from 'pg';

import { ENV_FILE_PATHS } from '../../src/config/env-values';

/** What marks a database as the suite's to empty. `truncateUsers` refuses any other. */
export const TEST_DATABASE_SUFFIX = '_test';

/** The Prisma CLI's own fallback (`prisma.config.ts`): the Compose database. */
const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/video_meetings';

/** Always there, and the one place a `CREATE DATABASE` can be issued from. */
const MAINTENANCE_DATABASE = 'postgres';

const API_ROOT = path.resolve(__dirname, '../..');

/**
 * The database a developer's environment names, read the way the API reads it: the shell
 * first, then the env files in `AppModule`'s order, then the Compose default.
 */
function configuredDatabaseUrl(): string {
  const fromFiles = ENV_FILE_PATHS.map(
    (file) =>
      config({ path: path.join(API_ROOT, file), processEnv: {}, quiet: true }).parsed?.[
        'DATABASE_URL'
      ],
  ).find((value) => value !== undefined && value !== '');

  return process.env['DATABASE_URL'] || fromFiles || DEFAULT_DATABASE_URL;
}

const databaseNameOf = (url: URL): string => decodeURIComponent(url.pathname.slice(1));

/**
 * The database the e2e suite runs against: the configured one with `_test` after its name,
 * on the same server and with the same credentials.
 *
 * The suite empties `users`, and everything that hangs off it, before every test. Run against
 * the database `DATABASE_URL` names, that was a developer's own data gone the first time they
 * ran `test:e2e` on a set-up machine. A name that already ends in `_test` is used as it is, so
 * the result can be fed back in — `setup-env.ts` runs once per spec file — and so pointing the
 * suite somewhere else on purpose is still one variable: name the database `…_test`.
 */
export function testDatabaseUrl(configured: string = configuredDatabaseUrl()): string {
  const url = new URL(configured);
  const name = databaseNameOf(url);

  if (!name.endsWith(TEST_DATABASE_SUFFIX)) {
    url.pathname = `/${encodeURIComponent(`${name}${TEST_DATABASE_SUFFIX}`)}`;
  }

  return url.toString();
}

/**
 * Makes sure the suite's database exists and holds the committed schema, so `test:e2e` needs
 * a running Postgres and nothing else. `migrate deploy`, as `pnpm start:dev` uses: it applies
 * what is committed and can neither generate a migration nor reset anything.
 */
export async function prepareTestDatabase(databaseUrl: string = testDatabaseUrl()): Promise<void> {
  const target = new URL(databaseUrl);
  const name = databaseNameOf(target);
  const maintenance = new URL(databaseUrl);

  maintenance.pathname = `/${MAINTENANCE_DATABASE}`;

  const client = new Client({ connectionString: maintenance.toString() });

  await client.connect();

  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);

    if (existing.rowCount === 0) {
      // An identifier cannot be a parameter; a doubled quote is how one is escaped inside it.
      await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    }
  } finally {
    await client.end();
  }

  execFileSync(path.join(API_ROOT, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}
