import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
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
