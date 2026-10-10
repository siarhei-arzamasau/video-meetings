import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How an access token is verified, stated once for whatever takes one. Today that is the
 * guard on every route, `/api/mcp` among them.
 */
@Injectable()
export class AccessTokenVerifier {
  constructor(private readonly jwt: JwtService) {}

  /**
   * The id of the user the token names, or `null` for a token that does not verify — forged,
   * expired, or naming nothing that can be a user. What a refusal means belongs to the
   * caller: on a route, a 401.
   *
   * That the user still exists is not decided here: this class reaches no database.
   */
  async subjectOf(accessToken: string): Promise<string | null> {
    let payload: { sub?: unknown; exp?: unknown };

    try {
      // `algorithms` is the load-bearing option. Left off, the verifier trusts the token's
      // own `alg` header, so an `alg: none` token with an empty signature is accepted and
      // anyone can mint a session as any user.
      payload = await this.jwt.verifyAsync<{ sub?: unknown; exp?: unknown }>(accessToken, {
        algorithms: ['HS256'],
      });
    } catch {
      return null;
    }

    const { sub, exp } = payload;

    // The library checks an expiry that is there and accepts a token that has none. Every
    // token this API issues has one, so one without is not ours — and a credential that
    // never expires is one nothing here could take back.
    if (typeof exp !== 'number') {
      return null;
    }

    // `id` is a uuid column: a non-uuid subject makes Postgres raise rather than simply
    // not match, which would surface as a 500 instead of a refusal.
    return typeof sub === 'string' && UUID_PATTERN.test(sub) ? sub : null;
  }
}
