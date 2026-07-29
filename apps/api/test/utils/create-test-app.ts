import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/configure-app';

/**
 * Boots the real application against the real database.
 *
 * The globals come from `configureApp`, the same function `main.ts` calls, so the app under
 * test cannot drift from the one that ships. Several specs assert behaviour that exists only
 * because of those globals — the 400s come from `ValidationPipe`, the error body shape from
 * `HttpExceptionFilter`, the URLs from the `api` prefix.
 *
 * The JWT environment is not set here: importing `AppModule` above already evaluated
 * `ConfigModule.forRoot()`, so by this point it is too late. `test/setup-env.ts` owns it.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  // `logger: false` keeps LoggingInterceptor's per-request output off the test report.
  const app = moduleRef.createNestApplication({ logger: false });

  configureApp(app);

  await app.init();

  return app;
}
