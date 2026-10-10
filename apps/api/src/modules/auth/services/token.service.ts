import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AuthResponse } from '@repo/shared';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The token is the whole response; `sub` is the only claim this API puts in it.
   *
   * Its lifetime is set here, not where the key is configured: `AccessTokenModule` is also
   * imported by a process that verifies tokens and never signs one, and must not ask it for
   * a variable only signing reads.
   */
  async issueToken(userId: string): Promise<AuthResponse> {
    const expiresIn = this.config.getOrThrow<number>('JWT_EXPIRES_IN_SECONDS');

    return { accessToken: await this.jwt.signAsync({ sub: userId }, { expiresIn }) };
  }
}
