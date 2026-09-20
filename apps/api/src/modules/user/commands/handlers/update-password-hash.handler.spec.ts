import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { UpdatePasswordHashCommand } from '../update-password-hash.command';
import { UpdatePasswordHashHandler } from './update-password-hash.handler';

describe('UpdatePasswordHashHandler', () => {
  const update = jest.fn();
  let handler: UpdatePasswordHashHandler;

  beforeEach(async () => {
    update.mockReset().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        UpdatePasswordHashHandler,
        { provide: PrismaService, useValue: { user: { update } } },
      ],
    }).compile();

    handler = moduleRef.get(UpdatePasswordHashHandler);
  });

  it('writes the hash against the caller from the command, and nothing else', async () => {
    await handler.execute(new UpdatePasswordHashCommand('user-id', 'new-hash'));

    expect(update).toHaveBeenCalledWith({
      where: { id: 'user-id' },
      data: { passwordHash: 'new-hash' },
    });
  });

  it('answers a row that vanished mid-request with a 401, not a 500', async () => {
    // The guard loaded this user moments ago, so a miss here is the account being deleted
    // between the guard's read and this write — the guard's own rule arriving one step later.
    update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );

    await expect(handler.execute(new UpdatePasswordHashCommand('user-id', 'h'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('lets every other database failure through unchanged', async () => {
    const failure = new Error('connection reset');
    update.mockRejectedValue(failure);

    await expect(handler.execute(new UpdatePasswordHashCommand('user-id', 'h'))).rejects.toBe(
      failure,
    );
  });
});
