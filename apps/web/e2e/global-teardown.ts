import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from 'dotenv';
import { Client } from 'pg';

/**
 * Leaves the developer database as it was found, mirroring `useApiSuite`'s `afterAll`.
 *
 * The suite runs in a separate process from the API, so it cannot call the API's raw-SQL
 * truncation helper; every test uses unique emails and its own meeting, so nothing here is
 * needed for correctness. `TRUNCATE ... CASCADE` follows the foreign keys to meetings,
 * participants, and files. The API's own temp storage directory goes the same way.
 */
export default async function globalTeardown(): Promise<void> {
  const apiEnv = path.resolve(__dirname, '../../api/.env');
  const { parsed } = config({ path: apiEnv, processEnv: {} });
  const connectionString = process.env['DATABASE_URL'] ?? parsed?.['DATABASE_URL'];

  if (connectionString === undefined) {
    throw new Error(`DATABASE_URL is not set and ${apiEnv} does not define it`);
  }

  const client = new Client({ connectionString });

  await client.connect();

  try {
    await client.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE');
  } finally {
    await client.end();
  }

  fs.rmSync(path.join(os.tmpdir(), 'meeting-files-e2e-web'), { recursive: true, force: true });
}
