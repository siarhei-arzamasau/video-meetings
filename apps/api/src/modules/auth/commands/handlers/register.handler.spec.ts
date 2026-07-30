import { ConflictException } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { CreateUserCommand } from '../../../user/commands/create-user.command';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { RegisterCommand } from '../register.command';
import { RegisterHandler } from './register.handler';

describe('RegisterHandler', () => {
  const execute = jest.fn();
  const hash = jest.fn<Promise<string>, [string]>();
  const issueToken = jest.fn();
  let handler: RegisterHandler;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue({ id: 'user-id' });
    hash.mockReset().mockResolvedValue('hashed-password');
    issueToken.mockReset().mockResolvedValue({ accessToken: 'signed.jwt.value' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        RegisterHandler,
        { provide: CommandBus, useValue: { execute } },
        { provide: PasswordService, useValue: { hash } },
        { provide: TokenService, useValue: { issueToken } },
      ],
    }).compile();

    handler = moduleRef.get(RegisterHandler);
  });

  it('hands the user module a hash, never the password', async () => {
    await handler.execute(new RegisterCommand('ada+test@example.com', 'correct horse'));

    expect(hash).toHaveBeenCalledWith('correct horse');
    expect(execute).toHaveBeenCalledWith(
      new CreateUserCommand('ada+test@example.com', 'hashed-password'),
    );
  });

  it('issues a token for the created user', async () => {
    const result = await handler.execute(new RegisterCommand('ada@example.com', 'pw'));

    expect(issueToken).toHaveBeenCalledWith('user-id');
    expect(result).toEqual({ accessToken: 'signed.jwt.value' });
  });

  it('lets the taken-address conflict through untouched', async () => {
    execute.mockRejectedValue(new ConflictException('That email is already registered'));

    // The 409 belongs to the handler that owns the unique index. Catching and re-throwing it
    // here would put the response for a taken address in two places at once.
    await expect(handler.execute(new RegisterCommand('taken@example.com', 'pw'))).rejects.toThrow(
      new ConflictException('That email is already registered'),
    );
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('lets any other failure through untouched', async () => {
    execute.mockRejectedValue(new Error('connection reset'));

    await expect(handler.execute(new RegisterCommand('ada@example.com', 'pw'))).rejects.toThrow(
      'connection reset',
    );
  });
});
