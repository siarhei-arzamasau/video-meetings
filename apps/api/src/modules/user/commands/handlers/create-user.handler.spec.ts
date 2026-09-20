import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateUserCommand } from '../create-user.command';
import { CreateUserHandler } from './create-user.handler';

describe('CreateUserHandler', () => {
  const create = jest.fn();
  let handler: CreateUserHandler;

  beforeEach(async () => {
    create.mockReset().mockResolvedValue({
      id: 'user-id',
      email: 'ada+test@example.com',
      displayName: 'ada+test',
      // A new account has no avatar. Stated rather than left off the mock: `toPublicUser`
      // reads both columns, and a row missing them is not a row Prisma can return.
      avatarKey: null,
      avatarVersion: 0,
      createdAt: new Date('2026-07-30T12:00:00.000Z'),
      passwordHash: 'hashed-password',
    });

    const moduleRef = await Test.createTestingModule({
      providers: [CreateUserHandler, { provide: PrismaService, useValue: { user: { create } } }],
    }).compile();

    handler = moduleRef.get(CreateUserHandler);
  });

  it('stores the hash it was handed and derives the display name', async () => {
    await handler.execute(new CreateUserCommand('ada+test@example.com', 'hashed-password'));

    expect(create).toHaveBeenCalledWith({
      data: {
        email: 'ada+test@example.com',
        passwordHash: 'hashed-password',
        displayName: 'ada+test',
      },
    });
  });

  it('returns the public user, never the stored hash', async () => {
    const user = await handler.execute(
      new CreateUserCommand('ada+test@example.com', 'hashed-password'),
    );

    expect(user).toEqual({
      id: 'user-id',
      email: 'ada+test@example.com',
      displayName: 'ada+test',
      avatarVersion: 0,
      createdAt: '2026-07-30T12:00:00.000Z',
    });
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('maps the unique-index violation to a 409', async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );

    await expect(
      handler.execute(new CreateUserCommand('taken@example.com', 'hashed-password')),
    ).rejects.toThrow(new ConflictException('That email is already registered'));
  });

  it('lets any other database error through untouched', async () => {
    create.mockRejectedValue(new Error('connection reset'));

    await expect(
      handler.execute(new CreateUserCommand('ada@example.com', 'hashed-password')),
    ).rejects.toThrow('connection reset');
  });
});
