import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AVATAR_CONTENT_TYPE } from '@repo/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { AvatarStorage } from '../storage/avatar-storage';
import { AvatarService } from './avatar.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const KEY = `${USER_ID}.webp`;

describe('AvatarService', () => {
  const findUnique = jest.fn();
  const stat = jest.fn();
  const openRead = jest.fn();
  let service: AvatarService;

  beforeEach(async () => {
    findUnique.mockReset().mockResolvedValue({ avatarKey: KEY });
    stat.mockReset().mockResolvedValue({ size: 4_096 });
    openRead.mockReset().mockReturnValue('a read stream');

    const moduleRef = await Test.createTestingModule({
      providers: [
        AvatarService,
        { provide: PrismaService, useValue: { user: { findUnique } } },
        { provide: AvatarStorage, useValue: { stat, openRead } },
      ],
    }).compile();

    service = moduleRef.get(AvatarService);
  });

  it('opens the stored rendition and names it WebP', async () => {
    await expect(service.openAvatar(USER_ID)).resolves.toEqual({
      contentType: AVATAR_CONTENT_TYPE,
      size: 4_096,
      stream: 'a read stream',
    });
    expect(openRead).toHaveBeenCalledWith(KEY);
  });

  it('selects the key and nothing else', async () => {
    await service.openAvatar(USER_ID);

    // A read that returns a whole user to stream one file is a read that will one day put a
    // column somewhere it does not belong.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { avatarKey: true },
    });
  });

  it.each([
    ['an account with no avatar', { avatarKey: null }],
    ['an id with no row', null],
  ])('answers %s with the same 404', async (_description, row) => {
    findUnique.mockResolvedValue(row);

    // Deliberately the same answer: telling the two apart would make a future
    // `/users/:id/avatar` an oracle for which ids exist.
    await expect(service.openAvatar(USER_ID)).rejects.toThrow(NotFoundException);
  });

  it('takes the id it is given rather than assuming the caller', async () => {
    // What keeps other people's avatars possible later without this method changing.
    await service.openAvatar('22222222-2222-4222-8222-222222222222');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: '22222222-2222-4222-8222-222222222222' },
      select: { avatarKey: true },
    });
  });
});
