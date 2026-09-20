import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '../../src/modules/prisma/prisma.service';
import { createTestApp } from './create-test-app';
import type { TestAppOptions } from './create-test-app';
import { truncateUsers } from './users-table';

export interface ApiSuite {
  /** Available from the first `beforeEach` onwards; throws if read at describe scope. */
  prisma(): PrismaService;
  /** The running application, for the rare spec that needs a provider by token. */
  app(): INestApplication;
  post(url: string, body: object): request.Test;
  patch(url: string, body: object): request.Test;
  /** A multipart request with one file part. `fieldName` defaults to the API's `file`. */
  postFile(
    url: string,
    token: string,
    file: string | Buffer,
    options?: { fieldName?: string; filename?: string },
  ): request.Test;
  get(url: string): request.Test;
  delete(url: string): request.Test;
}

/**
 * Registers the app lifecycle every e2e spec needs: one application per file, a truncated
 * database per test.
 *
 * Call it at describe scope — it registers `beforeAll`/`afterAll`/`beforeEach` itself. This
 * exists so the specs cannot drift apart in how they set up, which is the same failure mode
 * `createTestApp` warns about for `main.ts`.
 *
 * `truncateUsers` cascades, so this clears meetings and participants too — a spec for a table
 * with a foreign key to `users` inherits the cleanup instead of registering its own.
 */
export function useApiSuite(options: TestAppOptions = {}): ApiSuite {
  let app: INestApplication | undefined;
  let prisma: PrismaService | undefined;

  beforeAll(async () => {
    app = await createTestApp(options);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    try {
      // Leave the database as we found it. The `beforeEach` below is what isolates one test
      // from the next — and from a previous run — so correctness does not depend on this.
      // What it buys is not stranding fixture rows in the developer's database: without it,
      // whatever the last test happened to leave behind simply stays there.
      if (prisma !== undefined) {
        await truncateUsers(prisma);
      }
    } finally {
      // In a finally, so a failed cleanup cannot leak the application and its connection.
      await app?.close();
    }
  });

  // Before every test, not once per file: a test must not inherit rows from the test before
  // it, and running this first also clears anything a previous run left behind.
  beforeEach(async () => {
    await truncateUsers(assigned(prisma, 'prisma'));
  });

  return {
    prisma: () => assigned(prisma, 'prisma'),
    app: () => assigned(app, 'app'),
    post: (url, body) => request(assigned(app, 'app').getHttpServer()).post(url).send(body),
    patch: (url, body) => request(assigned(app, 'app').getHttpServer()).patch(url).send(body),
    postFile: (url, token, file, { fieldName = 'file', filename } = {}) =>
      request(assigned(app, 'app').getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .attach(fieldName, file, filename === undefined ? undefined : { filename }),
    get: (url) => request(assigned(app, 'app').getHttpServer()).get(url),
    delete: (url) => request(assigned(app, 'app').getHttpServer()).delete(url),
  };
}

function assigned<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} is not available yet — read it inside a test, not at describe scope`);
  }

  return value;
}
