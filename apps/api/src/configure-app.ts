import { INestApplication, ValidationPipe } from '@nestjs/common';

import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

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

  // Reflects the requesting origin, which is what local development needs.
  // Restrict this to a known origin list before deploying anywhere public.
  app.enableCors({ origin: true, credentials: true });

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
