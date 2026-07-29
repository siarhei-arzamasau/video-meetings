import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { RegisterCommand } from '../register.command';
import { RegisterHandler } from './register.handler';

describe('RegisterHandler', () => {
  const create = jest.fn();
  const hash = jest.fn<Promise<string>, [string]>();
  const issueToken = jest.fn();
  let handler: RegisterHandler;

  beforeEach(async () => {
    create.mockReset().mockResolvedValue({ id: 'user-id' });
    hash.mockReset().mockResolvedValue('hashed-password');
    issueToken.mockReset().mockResolvedValue({ accessToken: 'signed.jwt.value' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        RegisterHandler,
        { provide: PrismaService, useValue: { user: { create } } },
        { provide: PasswordService, useValue: { hash } },
        { provide: TokenService, useValue: { issueToken } },
      ],
    }).compile();

    handler = moduleRef.get(RegisterHandler);
  });

  it('stores the hash, never the password, and derives the display name', async () => {
    await handler.execute(new RegisterCommand('ada+test@example.com', 'correct horse'));

    expect(hash).toHaveBeenCalledWith('correct horse');
    expect(create).toHaveBeenCalledWith({
      data: {
        email: 'ada+test@example.com',
        passwordHash: 'hashed-password',
        displayName: 'ada+test',
      },
    });
  });

  it('issues a token for the created user', async () => {
    const result = await handler.execute(new RegisterCommand('ada@example.com', 'pw'));

    expect(issueToken).toHaveBeenCalledWith('user-id');
    expect(result).toEqual({ accessToken: 'signed.jwt.value' });
  });

  it('maps the unique-index violation to a 409', async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );

    await expect(handler.execute(new RegisterCommand('taken@example.com', 'pw'))).rejects.toThrow(
      new ConflictException('That email is already registered'),
    );
  });

  it('lets any other database error through untouched', async () => {
    create.mockRejectedValue(new Error('connection reset'));

    await expect(handler.execute(new RegisterCommand('ada@example.com', 'pw'))).rejects.toThrow(
      'connection reset',
    );
  });
});
