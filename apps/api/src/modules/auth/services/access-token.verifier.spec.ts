import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { AccessTokenVerifier } from './access-token.verifier';

const SECRET = 'a-secret-that-is-at-least-thirty-two-characters';
const USER_ID = '11111111-1111-4111-8111-111111111111';

/** `header.payload.` with no signature: what `alg: none` asks a verifier to accept. */
const unsignedToken = (payload: object): string =>
  [{ alg: 'none', typ: 'JWT' }, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.')
    .concat('.');

/**
 * The verifier over the real `JwtService`: what it refuses is the library's to decide given
 * the options it is handed, so a mock here would only show the options being passed.
 */
describe('AccessTokenVerifier', () => {
  let jwt: JwtService;
  let verifier: AccessTokenVerifier;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      // No `verifyOptions` on purpose: the per-call `algorithms` has to hold by itself.
      imports: [JwtModule.register({ secret: SECRET })],
      providers: [AccessTokenVerifier],
    }).compile();

    jwt = moduleRef.get(JwtService);
    verifier = moduleRef.get(AccessTokenVerifier);
  });

  it('answers the user a token of this key names', async () => {
    const token = await jwt.signAsync({ sub: USER_ID }, { expiresIn: 60 });

    await expect(verifier.subjectOf(token)).resolves.toBe(USER_ID);
  });

  it.each([
    [
      'signed with another key',
      () =>
        new JwtService({ secret: `${SECRET}-other` }).signAsync(
          { sub: USER_ID },
          { expiresIn: 60 },
        ),
    ],
    [
      'that has expired',
      () => jwt.signAsync({ sub: USER_ID, exp: Math.floor(Date.now() / 1_000) - 60 }),
    ],
    [
      'signed with an algorithm that is not HS256',
      () => jwt.signAsync({ sub: USER_ID }, { algorithm: 'HS512', expiresIn: 60 }),
    ],
    [
      'that claims no signature is needed',
      () =>
        Promise.resolve(unsignedToken({ sub: USER_ID, exp: Math.floor(Date.now() / 1_000) + 60 })),
    ],
    ['that never expires', () => jwt.signAsync({ sub: USER_ID })],
    ['whose subject is not a user id', () => jwt.signAsync({ sub: 'admin' }, { expiresIn: 60 })],
    ['with no subject', () => jwt.signAsync({ role: 'admin' }, { expiresIn: 60 })],
    ['that is not a token', () => Promise.resolve('not-a-token')],
    ['that is empty', () => Promise.resolve('')],
  ])('answers null for a token %s', async (_case, tokenOf) => {
    await expect(verifier.subjectOf(await tokenOf())).resolves.toBeNull();
  });
});
