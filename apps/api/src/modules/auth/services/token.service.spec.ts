import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { TokenService } from './token.service';

describe('TokenService', () => {
  const signAsync = jest.fn<Promise<string>, [object]>();
  let tokens: TokenService;

  beforeEach(async () => {
    signAsync.mockReset().mockResolvedValue('signed.jwt.value');

    const moduleRef = await Test.createTestingModule({
      providers: [TokenService, { provide: JwtService, useValue: { signAsync } }],
    }).compile();

    tokens = moduleRef.get(TokenService);
  });

  it('signs the user id as the only claim', async () => {
    await tokens.issueToken('11111111-2222-3333-4444-555555555555');

    expect(signAsync).toHaveBeenCalledWith({ sub: '11111111-2222-3333-4444-555555555555' });
  });

  it('returns the token as the whole response', async () => {
    await expect(tokens.issueToken('any-id')).resolves.toEqual({
      accessToken: 'signed.jwt.value',
    });
  });
});
