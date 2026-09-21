import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  BadRequestException,
  HttpException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import {
  AVATAR_DIMENSIONS_MESSAGE,
  AVATAR_EMPTY_MESSAGE,
  AVATAR_TYPE_MESSAGE,
  AVATAR_UNREADABLE_MESSAGE,
  type User,
} from '@repo/shared';

import { errorMessage } from '../../../../common/error-message';
import { isRecordNotFound } from '../../../prisma/prisma-errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { AvatarImage, type AvatarRejection } from '../../services/avatar-image';
import { toPublicUser } from '../../services/user.mapper';
import { AvatarStorage } from '../../storage/avatar-storage';
import { UploadAvatarCommand } from '../upload-avatar.command';

/**
 * Stores one avatar, synchronously inside the request.
 *
 * Unlike a meeting file there is no worker and no `processing` state, and the PRD says why:
 * the user is waiting to see the picture, and the file is small enough that making them wait
 * is cheaper than making them poll. The cost is that decoding happens on the request thread,
 * which the 5 MB cap and `AvatarImage`'s pixel cap between them bound.
 *
 * **The previous avatar survives every failure.** Nothing touches the stored object until the
 * new rendition exists in full, so an undecodable upload, a wrong type, or an empty file all
 * leave the account exactly as it was.
 *
 * **Bytes first, then the row, and each upload writes a key of its own.** The rendition lands
 * under a key nothing else names, and only then does the row point at it. The reverse order
 * would announce a version over bytes that were not there yet; this order can at worst leave
 * an object nothing points at, which is removed below on the path that can produce one.
 *
 * **The object the row stops pointing at is removed, and it is read in the same transaction
 * that replaces it.** That is what makes a replacement safe next to a concurrent removal: each
 * request only ever unlinks the object it saw the row holding, so neither can take away bytes
 * the other has just published. What they cannot decide between them is who wrote last, and
 * that is all they cannot decide: the row and the bytes agree either way.
 */
@CommandHandler(UploadAvatarCommand)
export class UploadAvatarHandler implements ICommandHandler<UploadAvatarCommand, User> {
  private readonly logger = new Logger(UploadAvatarHandler.name);

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
        throw refusalFor(result.reason);
      }

      const key = this.storage.newKey();

      await this.storage.put(key, rendition);

      return await this.recordAvatar(userId, key);
    } finally {
      await Promise.all([rm(tempPath, { force: true }), rm(rendition, { force: true })]);
    }
  }

  /**
   * Points the row at the new object and bumps the version, which is what tells a client the
   * image behind an unchanged path has changed, then removes the object it replaced.
   *
   * The previous key is read inside the transaction that overwrites it, so what is removed is
   * exactly what this request took the row's place from — never an object a concurrent upload
   * has since published.
   */
  private async recordAvatar(userId: string, key: string): Promise<User> {
    try {
      const [previous, user] = await this.prisma.$transaction([
        this.prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } }),
        this.prisma.user.update({
          where: { id: userId },
          data: { avatarKey: key, avatarVersion: { increment: 1 } },
        }),
      ]);

      await this.discard(previous?.avatarKey ?? null, userId);

      return toPublicUser(user);
    } catch (error) {
      // The row never took the object, so nothing points at the bytes just written and
      // nothing ever will: this key belongs to this request alone.
      await this.discard(key, userId);

      // As everywhere else in this module: the guard loaded this row moments ago, so a miss
      // means the account was deleted mid-request.
      if (isRecordNotFound(error)) {
        throw new UnauthorizedException();
      }

      throw error;
    }
  }

  /** Removes an object no row points at any more. Worth a line in the log and never worth
   *  failing a request that has already succeeded. */
  private async discard(key: string | null, userId: string): Promise<void> {
    if (key === null) {
      return;
    }

    try {
      await this.storage.remove(key);
    } catch (error) {
      this.logger.warn(`Could not remove the avatar object for ${userId}: ${errorMessage(error)}`);
    }
  }
}

/**
 * The status and sentence for each way a picture is refused. A type the contract does not take
 * is the one that is about the *kind* of file, which is what 415 means; the other two are
 * about this particular file, which is a 400.
 */
function refusalFor(reason: AvatarRejection): HttpException {
  switch (reason) {
    case 'type':
      return new UnsupportedMediaTypeException(AVATAR_TYPE_MESSAGE);
    case 'dimensions':
      return new BadRequestException(AVATAR_DIMENSIONS_MESSAGE);
    default:
      return new BadRequestException(AVATAR_UNREADABLE_MESSAGE);
  }
}
