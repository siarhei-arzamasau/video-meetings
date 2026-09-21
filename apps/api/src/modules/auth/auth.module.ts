import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthController } from './auth.controller';
import { authThrottlerOptions } from './auth-throttle.options';
import { ChangePasswordHandler } from './commands/handlers/change-password.handler';
import { LoginHandler } from './commands/handlers/login.handler';
import { RegisterHandler } from './commands/handlers/register.handler';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';

/**
 * Owns authentication: credentials, hashing, tokens, and the guard. It reaches no database —
 * every user row it needs comes from `UserModule` over the buses.
 *
 * The absence of `UserModule` from `imports` is deliberate and not an oversight. `CqrsModule`
 * registers every handler in the application into one set of buses, so naming a command or
 * query class is enough to reach its handler. Importing the module as well would add a
 * compile-time dependency that buys nothing and invites someone to inject a provider across
 * the boundary the buses exist to draw.
 */
@Module({
  imports: [
    // Imported per module rather than registered globally, so a module's `imports` states
    // what it actually needs. Every module that dispatches commands repeats this line.
    CqrsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: config.getOrThrow<number>('JWT_EXPIRES_IN_SECONDS'),
        },
        // Also set per call in JwtAuthGuard. Stated twice on purpose: a verify that forgets
        // it accepts `alg: none`, so the safe value is the default here as well.
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
    /**
     * Rate limiting for the credential routes. Registered here rather than globally because
     * this module owns the endpoints worth limiting; `ThrottlerModule` is `@Global()` of its
     * own accord, so the guard resolves wherever it is used, but nothing else is throttled
     * until a controller asks to be.
     *
     * **The tracker is `req.ip`, which `TRUST_PROXY_HOPS` decides.** At its default of zero it
     * is the socket address and `X-Forwarded-For` is ignored — the right default, because a
     * header-derived key is a key an attacker picks per request, which is no limit at all.
     * Behind a reverse proxy, though, every client then arrives as the proxy and shares one
     * budget, so a deployment that terminates TLS elsewhere sets the hop count to the number
     * of proxies in front, and no higher (`env.validation.ts` says what one too many costs).
     *
     * Storage is in-process, so each replica counts its own. One API container counts
     * everything; a scaled-out deployment multiplies the effective limit by its replica count
     * and wants a shared store (`ThrottlerStorageRedisService`) instead.
     *
     * The options are a function in `auth-throttle.options.ts` rather than a literal here, so
     * `auth-rate-limit.e2e-spec.ts` can narrow the budget to something a test can spend
     * without restating the key strategy it exists to check.
     */
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        authThrottlerOptions(
          config.getOrThrow<number>('AUTH_RATE_LIMIT_WINDOW_SECONDS'),
          config.getOrThrow<number>('AUTH_RATE_LIMIT_ATTEMPTS'),
        ),
    }),
  ],
  controllers: [AuthController],
  providers: [
    RegisterHandler,
    LoginHandler,
    ChangePasswordHandler,
    PasswordService,
    TokenService,
    JwtAuthGuard,
  ],
  exports: [JwtModule, JwtAuthGuard],
})
export class AuthModule {}
