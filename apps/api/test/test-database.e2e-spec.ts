import { Client } from 'pg';

import { useApiSuite } from './utils/api-suite';
import { TEST_DATABASE_SUFFIX, testDatabaseUrl } from './utils/test-database';
import { truncateUsers } from './utils/users-table';

const DEVELOPMENT_URL = 'postgresql://postgres:postgres@localhost:5433/video_meetings';

/**
 * The suite empties `users` before every test, so which database it is connected to is the
 * difference between a test run and a developer's data. These hold it to one of its own.
 */
describe('the database the e2e suite runs against', () => {
  const suite = useApiSuite();

  it('is the configured one with _test after its name, on the same server', () => {
    expect(testDatabaseUrl(DEVELOPMENT_URL)).toBe(`${DEVELOPMENT_URL}_test`);
  });

  it('keeps the query a connection string carries', () => {
    expect(testDatabaseUrl(`${DEVELOPMENT_URL}?schema=public`)).toBe(
      `${DEVELOPMENT_URL}_test?schema=public`,
    );
  });

  // `setup-env.ts` runs once per spec file and writes the answer back to `DATABASE_URL`, so
  // the answer has to be its own answer — and a database named on purpose is used as named.
  it('leaves a name that already ends in _test alone', () => {
    const chosen = 'postgresql://postgres:postgres@localhost:5433/video_meetings_mine_test';

    expect(testDatabaseUrl(chosen)).toBe(chosen);
    expect(testDatabaseUrl(testDatabaseUrl(DEVELOPMENT_URL))).toBe(`${DEVELOPMENT_URL}_test`);
  });

  it('is what the application under test is connected to', async () => {
    const rows = await suite
      .prisma()
      .$queryRawUnsafe<{ name: string }[]>('SELECT current_database() AS name');

    expect(rows[0]?.name.endsWith(TEST_DATABASE_SUFFIX)).toBe(true);
    expect(process.env['DATABASE_URL']).toBe(testDatabaseUrl());
  });

  // Against the maintenance database, which every server has and whose name is not a test
  // database's. The refusal comes before the TRUNCATE in one statement, so nothing is touched.
  it('refuses to empty a database that is not a test database', async () => {
    const elsewhere = new URL(testDatabaseUrl());

    elsewhere.pathname = '/postgres';

    const client = new Client({ connectionString: elsewhere.toString() });

    await client.connect();

    try {
      await expect(
        truncateUsers({
          $executeRawUnsafe: (statement: string) => client.query(statement),
        } as never),
      ).rejects.toThrow('Refusing to truncate "postgres": not a test database');
    } finally {
      await client.end();
    }
  });
});
