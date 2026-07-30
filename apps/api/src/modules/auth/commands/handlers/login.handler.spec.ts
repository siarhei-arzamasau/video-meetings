import { UnauthorizedException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { FindUserCredentialsByEmailQuery } from '../../../user/queries/find-user-credentials-by-email.query';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { LoginCommand } from '../login.command';
import { LoginHandler } from './login.handler';

describe('LoginHandler', () => {
  const execute = jest.fn();
  const verify = jest.fn<Promise<boolean>, [string, string]>();
  const verifyDummy = jest.fn<Promise<void>, [string]>();
  const issueToken = jest.fn();
  let handler: LoginHandler;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue({ id: 'user-id', passwordHash: 'stored-hash' });
    verify.mockReset().mockResolvedValue(true);
    verifyDummy.mockReset().mockResolvedValue(undefined);
    issueToken.mockReset().mockResolvedValue({ accessToken: 'signed.jwt.value' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        LoginHandler,
        { provide: QueryBus, useValue: { execute } },
        { provide: PasswordService, useValue: { verify, verifyDummy } },
        { provide: TokenService, useValue: { issueToken } },
      ],
    }).compile();

    handler = moduleRef.get(LoginHandler);
  });

  it('issues a token when the password verifies', async () => {
    const result = await handler.execute(new LoginCommand('ada@example.com', 'correct horse'));

    expect(execute).toHaveBeenCalledWith(new FindUserCredentialsByEmailQuery('ada@example.com'));
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
    execute.mockResolvedValue(null);

    await expect(handler.execute(new LoginCommand('nobody@example.com', 'pw'))).rejects.toThrow(
      new UnauthorizedException('Invalid email or password'),
    );
  });

  it('still spends verification work when no account matches', async () => {
    execute.mockResolvedValue(null);

    await expect(handler.execute(new LoginCommand('nobody@example.com', 'pw'))).rejects.toThrow(
      UnauthorizedException,
    );
    // Without this, argon2 runs only on the hit path and response time tells an attacker
    // which addresses have accounts — the enumeration the shared message exists to prevent.
    expect(verifyDummy).toHaveBeenCalledWith('pw');
  });
});
