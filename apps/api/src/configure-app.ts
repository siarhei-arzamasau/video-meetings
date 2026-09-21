import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Express } from 'express';
import helmet from 'helmet';

import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

/**
 * The response headers every answer carries. This API serves JSON and attachments and nothing
 * a browser should render, so the policy allows nothing at all: were some response ever shown
 * as a page, no script, style, frame or request could come of it. HSTS is left to whatever
 * terminates TLS — this process cannot know whether anything does.
 */
const SECURITY_HEADERS = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  },
  strictTransportSecurity: false,
  xFrameOptions: { action: 'deny' },
});

/**
 * Every global that shapes request handling, in one function.
 *
 * `main.ts` and the e2e test app both call this. They used to configure themselves
 * separately, which meant a new global could be added to the running application while the
 * tests kept passing against an app that no longer resembled it. Anything that changes how
 * a request is validated, routed, or rendered belongs here — not in `main.ts`.
 *
 * Process-level concerns (listening, shutdown hooks) stay in `main.ts`: they are not part
 * of the request pipeline and the test harness must not install them.
 */
export function configureApp(app: INestApplication): void {
  // A controller at @Controller('auth') serves /api/auth.
  app.setGlobalPrefix('api');

  // Which address a request comes from, and so whose budget the auth throttle charges it to.
  // Zero hops unless configured — `TRUST_PROXY_HOPS` in env.validation.ts says why that is the
  // only safe default, and what one hop too many costs.
  const express: Express = app.getHttpAdapter().getInstance();

  express.set('trust proxy', app.get(ConfigService).getOrThrow<number>('TRUST_PROXY_HOPS'));

  // Before CORS, so a preflight answer carries them too.
  app.use(SECURITY_HEADERS);

  // Exactly the origins `CORS_ORIGINS` names; any other is answered without an
  // `Access-Control-Allow-Origin`, so its page cannot read the response. `env.validation.ts`
  // says why it is a list, and what development gets without one.
  app.enableCors({
    origin: app.get(ConfigService).getOrThrow<string[]>('CORS_ORIGINS'),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Deliberately NOT enableImplicitConversion. With it on, class-transformer coerces
      // a value into whatever the DTO property is typed as, so `{"password": 12345678}`
      // arrives as the string "12345678" and validates — the API would silently accept
      // credentials of any JSON type. Off, `@IsString()` means what it says.
      //
      // The cost is that numeric query and param DTOs need an explicit `@Type(() => Number)`.
      // That is the better trade: one decorator where a conversion is wanted, rather than
      // implicit coercion everywhere it is not.
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
}
