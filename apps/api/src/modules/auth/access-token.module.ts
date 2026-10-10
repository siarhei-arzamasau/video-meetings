import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { AccessTokenVerifier } from './services/access-token.verifier';

/**
 * The signing key and how a token is verified with it — the part of authentication a
 * process needs in order to take a token, and nothing a process needs in order to give one.
 *
 * It is a module of its own so that something which only takes a token can import it
 * alone, as `McpModule` does for the guard on `/api/mcp`. `AuthModule` adds to it everything
 * that issues one: the credential routes, argon2, the rate limit.
 *
 * **A token's lifetime is not configured here.** It is `TokenService`'s, set as it signs, so
 * that importing this module asks for `JWT_SECRET` and no other variable.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { algorithm: 'HS256' },
        // Also set per call in AccessTokenVerifier. Stated twice on purpose: a verify that
        // forgets it accepts `alg: none`, so the safe value is the default here as well.
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  providers: [AccessTokenVerifier],
  exports: [JwtModule, AccessTokenVerifier],
})
export class AccessTokenModule {}
