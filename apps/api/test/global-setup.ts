import { prepareTestDatabase } from './utils/test-database';

/**
 * Jest `globalSetup` — once per run, before any spec file: the suite's own database, created
 * if it is missing and migrated to what is committed. `setup-env.ts` points every spec at the
 * same one; the two agree because both ask `testDatabaseUrl`.
 */
export default async function globalSetup(): Promise<void> {
  await prepareTestDatabase();
}
