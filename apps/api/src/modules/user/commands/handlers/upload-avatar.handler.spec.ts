import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BadRequestException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AVATAR_EMPTY_MESSAGE, AVATAR_TYPE_MESSAGE, AVATAR_UNREADABLE_MESSAGE } from '@repo/shared';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AvatarImage } from '../../services/avatar-image';
import { AvatarStorage } from '../../storage/avatar-storage';
import { UploadAvatarCommand } from '../upload-avatar.command';
import { UploadAvatarHandler } from './upload-avatar.handler';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const KEY = `${USER_ID}.webp`;

const ROW = {
  id: USER_ID,
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  passwordHash: 'hashed',
  avatarKey: KEY,
  avatarVersion: 3,
  createdAt: new Date('2026-07-30T12:00:00.000Z'),
};

describe('UploadAvatarHandler', () => {
  const update = jest.fn();
  const normalise = jest.fn();
  const put = jest.fn();
  let handler: UploadAvatarHandler;
  let tempDir: string;
  let tempPath: string;

  const upload = (size = 1_024): Promise<unknown> =>
    handler.execute(new UploadAvatarCommand(USER_ID, tempPath, size));

  /** The rendition `normalise` was told to write, so a test can see whether it was cleaned up. */
  const renditionPath = (): string => String(normalise.mock.calls[0]?.[1]);

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-avatar-'));
    tempPath = path.join(tempDir, 'incoming');
    fs.writeFileSync(tempPath, 'the uploaded bytes');

    update.mockReset().mockResolvedValue(ROW);
    put.mockReset().mockResolvedValue(undefined);
    normalise
      .mockReset()
      .mockImplementation((_source: string, destination: string): Promise<{ ok: boolean }> => {
        fs.writeFileSync(destination, 'the rendition');

        return Promise.resolve({ ok: true });
      });

    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadAvatarHandler,
        { provide: PrismaService, useValue: { user: { update } } },
        {
          provide: AvatarStorage,
          useValue: { tempDir: () => tempDir, keyOf: () => KEY, put },
        },
        { provide: AvatarImage, useValue: { normalise } },
      ],
    }).compile();

    handler = moduleRef.get(UploadAvatarHandler);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('a picture the server can read', () => {
    it('stores the rendition and bumps the version', async () => {
      await upload();

      expect(normalise).toHaveBeenCalledWith(tempPath, expect.stringContaining(tempDir));
      expect(put).toHaveBeenCalledWith(KEY, renditionPath());
      expect(update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { avatarKey: KEY, avatarVersion: { increment: 1 } },
      });
    });

    it('answers with the public user, carrying the path and the new version', async () => {
      await expect(upload()).resolves.toEqual({
        id: USER_ID,
        email: 'ada@example.com',
        displayName: 'Ada Lovelace',
        avatarPath: '/users/me/avatar',
        avatarVersion: 3,
        createdAt: '2026-07-30T12:00:00.000Z',
      });
    });

    it('never lets the stored hash into the answer', async () => {
      await expect(upload()).resolves.not.toHaveProperty('passwordHash');
    });

    it('writes the bytes before it announces them', async () => {
      // The other order would publish a version over the old image. This one can at worst
      // leave the new image under the old version, which the next upload corrects.
      const order: string[] = [];
      put.mockImplementation(() => {
        order.push('put');

        return Promise.resolve();
      });
      update.mockImplementation(() => {
        order.push('update');

        return Promise.resolve(ROW);
      });

      await upload();

      expect(order).toEqual(['put', 'update']);
    });

    it('removes both temporary files', async () => {
      const rendition = await upload().then(() => renditionPath());

      expect(fs.existsSync(tempPath)).toBe(false);
      expect(fs.existsSync(rendition)).toBe(false);
    });
  });

  describe('a picture the server refuses', () => {
    it('answers an empty file with its own sentence, before decoding anything', async () => {
      // "Unreadable" would send the user looking for a corrupted image instead of an empty one.
      await expect(upload(0)).rejects.toThrow(new BadRequestException(AVATAR_EMPTY_MESSAGE));
      expect(normalise).not.toHaveBeenCalled();
    });

    it('answers a type the contract does not take with a 415', async () => {
      normalise.mockResolvedValue({ ok: false, reason: 'type' });

      await expect(upload()).rejects.toThrow(
        new UnsupportedMediaTypeException(AVATAR_TYPE_MESSAGE),
      );
    });

    it('answers a file it cannot decode with a 400', async () => {
      normalise.mockResolvedValue({ ok: false, reason: 'unreadable' });

      await expect(upload()).rejects.toThrow(new BadRequestException(AVATAR_UNREADABLE_MESSAGE));
    });

    it.each([
      ['an empty file', 0, undefined],
      ['a wrong type', 1_024, { ok: false, reason: 'type' }],
      ['an undecodable file', 1_024, { ok: false, reason: 'unreadable' }],
    ])('leaves the previous avatar in place for %s', async (_description, size, result) => {
      if (result !== undefined) {
        normalise.mockResolvedValue(result);
      }

      await expect(upload(size)).rejects.toThrow();

      // Nothing was moved into place and nothing was written to the row, so the account is
      // exactly as it was — the PRD's rule, and the reason the rendition goes to a temp path.
      expect(put).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('still removes the upload when it refuses it', async () => {
      normalise.mockResolvedValue({ ok: false, reason: 'unreadable' });

      await expect(upload()).rejects.toThrow();

      expect(fs.existsSync(tempPath)).toBe(false);
    });

    it('removes the upload when the database write fails', async () => {
      update.mockRejectedValue(new Error('connection reset'));

      await expect(upload()).rejects.toThrow('connection reset');

      expect(fs.existsSync(tempPath)).toBe(false);
      expect(fs.existsSync(renditionPath())).toBe(false);
    });

    it('answers a row that vanished mid-request with a 401, not a 500', async () => {
      update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(upload()).rejects.toThrow(UnauthorizedException);
    });
  });
});
