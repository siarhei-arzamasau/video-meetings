import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  BadRequestException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import {
  AVATAR_EMPTY_MESSAGE,
  AVATAR_TYPE_MESSAGE,
  AVATAR_UNREADABLE_MESSAGE,
  type User,
} from '@repo/shared';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AvatarImage } from '../../services/avatar-image';
import { toPublicUser } from '../../services/user.mapper';
import { AvatarStorage } from '../../storage/avatar-storage';
import { UploadAvatarCommand } from '../upload-avatar.command';

/**
 * Stores one avatar, synchronously inside the request.
 *
 * Unlike a meeting file there is no worker and no `processing` state, and the PRD says why:
 * the user is waiting to see the picture, and the file is small enough that making them wait
 * is cheaper than making them poll. The cost is that decoding happens on the request thread,
 * which the 5 MB cap and `sharp`'s own input limits bound.
 *
 * **The previous avatar survives every failure.** Nothing touches the stored object until the
 * new rendition exists in full, so an undecodable upload, a wrong type, or an empty file all
 * leave the account exactly as it was.
 *
 * **Bytes first, then the row.** The rendition is moved into place and only then is the
 * version bumped. The reverse order would announce a new version over the old image; this
 * order can at worst leave the new image under the old version, which the next upload
 * corrects.
 *
 * The one cost of that order is worth stating plainly, because it is easy to assume away: on
 * a **first** upload the bytes are written while `avatarKey` is still null, so a row update
 * that fails leaves `avatars/<userId>.webp` on disk with nothing pointing at it, and there is
 * no purger for this subtree. It is bounded — one file per account, overwritten by that
 * account's next successful upload, because the key is derived from the id and never
 * changes — but it is not nothing, and a reader should not be told otherwise.
 */
@CommandHandler(UploadAvatarCommand)
export class UploadAvatarHandler implements ICommandHandler<UploadAvatarCommand, User> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: AvatarStorage,
    private readonly images: AvatarImage,
  ) {}

  async execute({ userId, tempPath, size }: UploadAvatarCommand): Promise<User> {
    // Every exit removes the upload, including the ones that throw. The interceptor's own
    // cleanup covers what fails before this handler is reached.
    const rendition = path.join(this.storage.tempDir(), `${randomUUID()}.webp`);

    try {
      if (size === 0) {
        // Multer writes a zero-byte file happily, and `sharp` would call it unreadable — a
        // sentence that sends the user looking for a corrupted image instead of an empty one.
        throw new BadRequestException(AVATAR_EMPTY_MESSAGE);
      }

      const result = await this.images.normalise(tempPath, rendition);

      if (!result.ok) {
        throw result.reason === 'type'
          ? new UnsupportedMediaTypeException(AVATAR_TYPE_MESSAGE)
          : new BadRequestException(AVATAR_UNREADABLE_MESSAGE);
      }

      await this.storage.put(this.storage.keyOf(userId), rendition);

      return await this.recordAvatar(userId);
    } finally {
      await Promise.all([rm(tempPath, { force: true }), rm(rendition, { force: true })]);
    }
  }

  /** Points the row at the object and bumps the version, which is what tells a client the
   *  image behind an unchanged path has changed. */
  private async recordAvatar(userId: string): Promise<User> {
    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: { avatarKey: this.storage.keyOf(userId), avatarVersion: { increment: 1 } },
      });

      return toPublicUser(user);
    } catch (error) {
      // As everywhere else in this module: the guard loaded this row moments ago, so a miss
      // means the account was deleted mid-request.
      if (isRecordNotFound(error)) {
        throw new UnauthorizedException();
      }

      throw error;
    }
  }
}

function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
