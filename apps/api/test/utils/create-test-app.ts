import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
export interface TestAppOptions {
  /**
   * Providers to replace, by token. For the boundaries a spec must not cross for real — the
   * transcription provider is the only one so far, and it is a string token precisely so a
   * spec can bind a fake without importing the module it belongs to.
   */
  overrides?: ReadonlyArray<{ token: unknown; value: unknown }>;
  /**
   * Environment values to set before `configureApp` reads them — for the globals it configures
   * from the environment, which `test/setup-env.ts` can set only once for the whole run.
   * `TRUST_PROXY_HOPS` is the one so far. They go in through `ConfigService.set`, which is also
   * how the file specs change a flag between tests.
   */
  config?: Readonly<Record<string, unknown>>;
}

export async function createTestApp({
  overrides = [],
  config = {},
}: TestAppOptions = {}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });

  for (const { token, value } of overrides) {
    builder.overrideProvider(token).useValue(value);
  }

  const moduleRef = await builder.compile();

  // `logger: false` keeps LoggingInterceptor's per-request output off the test report.
  const app = moduleRef.createNestApplication({ logger: false });
  const configService = app.get(ConfigService);

  for (const [key, value] of Object.entries(config)) {
    configService.set(key, value);
  }

  configureApp(app);

  await app.init();

  return app;
}
