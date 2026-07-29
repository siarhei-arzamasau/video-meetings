import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthResponse } from '@repo/shared';

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  /** The token is the whole response; `sub` is the only claim this API puts in it. */
  async issueToken(userId: string): Promise<AuthResponse> {
    return { accessToken: await this.jwt.signAsync({ sub: userId }) };
  }
}
