import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { TokenService } from './token.service';

const EXPIRES_IN_SECONDS = 900;

describe('TokenService', () => {
  const signAsync = jest.fn<Promise<string>, [object, object]>();
  const getOrThrow = jest.fn();
  let tokens: TokenService;

  beforeEach(async () => {
    signAsync.mockReset().mockResolvedValue('signed.jwt.value');
    getOrThrow.mockReset().mockReturnValue(EXPIRES_IN_SECONDS);

    const moduleRef = await Test.createTestingModule({
      providers: [
        TokenService,
        { provide: JwtService, useValue: { signAsync } },
        { provide: ConfigService, useValue: { getOrThrow } },
      ],
    }).compile();

    tokens = moduleRef.get(TokenService);
  });

  it('signs the user id as the only claim', async () => {
    await tokens.issueToken('11111111-2222-3333-4444-555555555555');

    expect(signAsync).toHaveBeenCalledWith(
      { sub: '11111111-2222-3333-4444-555555555555' },
      expect.anything(),
    );
  });

  it('gives the token the configured lifetime, as it signs', async () => {
    await tokens.issueToken('any-id');

    // Not left to the module that holds the key: whatever only verifies imports that
    // module too, and has no lifetime to configure.
    expect(getOrThrow).toHaveBeenCalledWith('JWT_EXPIRES_IN_SECONDS');
    expect(signAsync).toHaveBeenCalledWith(expect.anything(), { expiresIn: EXPIRES_IN_SECONDS });
  });

  it('returns the token as the whole response', async () => {
    await expect(tokens.issueToken('any-id')).resolves.toEqual({
      accessToken: 'signed.jwt.value',
    });
  });
});

/**
 * The same service over the real `JwtService`, as `AccessTokenModule` configures it: the
 * mocks above show an option being passed, and only a signed token shows what it did.
 */
describe('TokenService, signing for real', () => {
  it('issues an HS256 token that expires when the configured lifetime is up', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: 'a-secret-that-is-at-least-thirty-two-characters',
          signOptions: { algorithm: 'HS256' },
        }),
      ],
      providers: [
        TokenService,
        { provide: ConfigService, useValue: { getOrThrow: () => EXPIRES_IN_SECONDS } },
      ],
    }).compile();

    const { accessToken } = await moduleRef.get(TokenService).issueToken('any-id');
    const { header, payload } = moduleRef.get(JwtService).decode<{
      header: { alg: string };
      payload: { sub: string; iat: number; exp: number };
    }>(accessToken, { complete: true });

    expect(header.alg).toBe('HS256');
    expect(payload.sub).toBe('any-id');
    // A token with no expiry is one the verifier refuses, and one nothing could take back.
    expect(payload.exp - payload.iat).toBe(EXPIRES_IN_SECONDS);
  });
});
