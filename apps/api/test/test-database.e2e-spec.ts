import { Client } from 'pg';

import { useApiSuite } from './utils/api-suite';
import {
  TEST_DATABASE_SUFFIX,
  browserSuiteDatabaseUrl,
  testDatabaseUrl,
} from './utils/test-database';
import { truncateUsers } from './utils/users-table';

const DEVELOPMENT_URL = 'postgresql://postgres:postgres@localhost:5433/video_meetings';

/** `truncateUsers` over a connection to another database of the same server. */
const truncateIn = async (database: string): Promise<void> => {
  const elsewhere = new URL(testDatabaseUrl());

  elsewhere.pathname = `/${database}`;

  const client = new Client({ connectionString: elsewhere.toString() });

  await client.connect();

  try {
    await truncateUsers({
      $executeRawUnsafe: (statement: string) => client.query(statement),
    } as never);
  } finally {
    await client.end();
  }
};

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

  // The browser suite's suffix ends in this suite's. Used as it is, such a name would hand
  // both suites one database, each emptying it under the other.
  it('is never the browser suite’s, whatever database is configured', () => {
    const browserSuites = `${DEVELOPMENT_URL}_web_test`;

    expect(browserSuiteDatabaseUrl(DEVELOPMENT_URL)).toBe(browserSuites);
    expect(browserSuiteDatabaseUrl(browserSuites)).toBe(browserSuites);
    expect(testDatabaseUrl(browserSuites)).toBe(`${browserSuites}_test`);
    expect(testDatabaseUrl(testDatabaseUrl(browserSuites))).toBe(`${browserSuites}_test`);

    for (const name of ['video_meetings', 'mine_test', 'mine_web_test', 'mine_web_test_test']) {
      const configured = `postgresql://postgres:postgres@localhost:5433/${name}`;

      expect(testDatabaseUrl(configured)).not.toBe(browserSuiteDatabaseUrl(configured));
    }
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
    await expect(truncateIn('postgres')).rejects.toThrow(
      'Refusing to truncate "postgres": not a test database',
    );
  });

  // A database made for the purpose and dropped again: the name is what is refused, and the
  // refusal comes first, so it needs no schema.
  it('refuses to empty the browser suite’s database, which is another suite’s', async () => {
    const database = `refusal_${String(process.pid)}_web_test`;
    const maintenance = async (statement: string): Promise<void> => {
      await suite.prisma().$executeRawUnsafe(statement);
    };

    await maintenance(`CREATE DATABASE "${database}"`);

    try {
      await expect(truncateIn(database)).rejects.toThrow(
        `Refusing to truncate "${database}": the browser suite's database`,
      );
    } finally {
      await maintenance(`DROP DATABASE "${database}"`);
    }
  });
});
