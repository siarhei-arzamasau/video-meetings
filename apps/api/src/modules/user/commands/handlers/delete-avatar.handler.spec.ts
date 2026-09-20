import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { AvatarStorage } from '../../storage/avatar-storage';
import { DeleteAvatarCommand } from '../delete-avatar.command';
import { DeleteAvatarHandler } from './delete-avatar.handler';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const KEY = `${USER_ID}.webp`;

const WITH_AVATAR = {
  id: USER_ID,
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  passwordHash: 'hashed',
  avatarKey: KEY,
  avatarVersion: 3,
  createdAt: new Date('2026-07-30T12:00:00.000Z'),
};

const CLEARED = { ...WITH_AVATAR, avatarKey: null, avatarVersion: 4 };
const NEVER_HAD_ONE = { ...WITH_AVATAR, avatarKey: null, avatarVersion: 0 };

describe('DeleteAvatarHandler', () => {
  const findUnique = jest.fn();
  const update = jest.fn();
  const remove = jest.fn();
  let handler: DeleteAvatarHandler;

  const deleteAvatar = () => handler.execute(new DeleteAvatarCommand(USER_ID));

  beforeEach(async () => {
    findUnique.mockReset().mockResolvedValue(WITH_AVATAR);
    update.mockReset().mockResolvedValue(CLEARED);
    remove.mockReset().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        DeleteAvatarHandler,
        { provide: PrismaService, useValue: { user: { findUnique, update } } },
        { provide: AvatarStorage, useValue: { remove } },
      ],
    }).compile();

    handler = moduleRef.get(DeleteAvatarHandler);
  });

  describe('an account that has one', () => {
    it('clears the reference, bumps the version, and removes the object', async () => {
      await deleteAvatar();

      expect(update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { avatarKey: null, avatarVersion: { increment: 1 } },
      });
      expect(remove).toHaveBeenCalledWith(KEY);
    });

    it('clears the row before it removes the bytes', async () => {
      // That order is what makes the previous URL stop working immediately. The reverse
      // would leave a row pointing at a file that is gone, and a 500 on every read of it.
      const order: string[] = [];
      update.mockImplementation(() => {
        order.push('update');

        return Promise.resolve(CLEARED);
      });
      remove.mockImplementation(() => {
        order.push('remove');

        return Promise.resolve();
      });

      await deleteAvatar();

      expect(order).toEqual(['update', 'remove']);
    });

    it('answers with a user carrying no avatar path and the bumped version', async () => {
      const user = await deleteAvatar();

      expect(user).not.toHaveProperty('avatarPath');
      expect(user.avatarVersion).toBe(4);
    });

    it('succeeds even when the object cannot be removed', async () => {
      // The reference is already gone, so the avatar is removed as far as any caller is
      // concerned. What is left is an unreferenced file, which is a log line and not a 500.
      remove.mockRejectedValue(new Error('EBUSY'));

      await expect(deleteAvatar()).resolves.toMatchObject({ avatarVersion: 4 });
    });
  });

  describe('an account that has none', () => {
    it('is a no-op rather than an error', async () => {
      findUnique.mockResolvedValue(NEVER_HAD_ONE);

      await expect(deleteAvatar()).resolves.toMatchObject({ avatarVersion: 0 });
    });

    it('leaves the version alone, so no client re-fetches for nothing', async () => {
      findUnique.mockResolvedValue(NEVER_HAD_ONE);

      await deleteAvatar();

      expect(update).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });
  });

  it('answers a token whose subject is gone with a 401', async () => {
    findUnique.mockResolvedValue(null);

    await expect(deleteAvatar()).rejects.toThrow(UnauthorizedException);
    expect(update).not.toHaveBeenCalled();
  });
});
