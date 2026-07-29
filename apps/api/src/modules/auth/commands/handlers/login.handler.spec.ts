import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { LoginCommand } from '../login.command';
import { LoginHandler } from './login.handler';

describe('LoginHandler', () => {
  const findUnique = jest.fn();
  const verify = jest.fn<Promise<boolean>, [string, string]>();
  const verifyDummy = jest.fn<Promise<void>, [string]>();
  const issueToken = jest.fn();
  let handler: LoginHandler;

  beforeEach(async () => {
    findUnique.mockReset().mockResolvedValue({ id: 'user-id', passwordHash: 'stored-hash' });
    verify.mockReset().mockResolvedValue(true);
    verifyDummy.mockReset().mockResolvedValue(undefined);
    issueToken.mockReset().mockResolvedValue({ accessToken: 'signed.jwt.value' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        LoginHandler,
        { provide: PrismaService, useValue: { user: { findUnique } } },
        { provide: PasswordService, useValue: { verify, verifyDummy } },
        { provide: TokenService, useValue: { issueToken } },
      ],
    }).compile();

    handler = moduleRef.get(LoginHandler);
  });

  it('issues a token when the password verifies', async () => {
    const result = await handler.execute(new LoginCommand('ada@example.com', 'correct horse'));

    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'ada@example.com' } });
    expect(verify).toHaveBeenCalledWith('stored-hash', 'correct horse');
    expect(issueToken).toHaveBeenCalledWith('user-id');
    expect(result).toEqual({ accessToken: 'signed.jwt.value' });
  });

  it('rejects a wrong password with the shared message', async () => {
    verify.mockResolvedValue(false);

    await expect(handler.execute(new LoginCommand('ada@example.com', 'wrong'))).rejects.toThrow(
      new UnauthorizedException('Invalid email or password'),
    );
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('gives an unknown email the identical message', async () => {
    findUnique.mockResolvedValue(null);

    await expect(handler.execute(new LoginCommand('nobody@example.com', 'pw'))).rejects.toThrow(
      new UnauthorizedException('Invalid email or password'),
    );
  });

  it('still spends verification work when no account matches', async () => {
    findUnique.mockResolvedValue(null);

    await expect(handler.execute(new LoginCommand('nobody@example.com', 'pw'))).rejects.toThrow(
      UnauthorizedException,
    );
    // Without this, argon2 runs only on the hit path and response time tells an attacker
    // which addresses have accounts — the enumeration the shared message exists to prevent.
    expect(verifyDummy).toHaveBeenCalledWith('pw');
  });
});
