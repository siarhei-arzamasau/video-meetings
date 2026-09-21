import type { ReadStream } from 'node:fs';

import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { AVATAR_CONTENT_TYPE } from '@repo/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { AvatarStorage } from '../storage/avatar-storage';

export const AVATAR_NOT_FOUND = 'No avatar';

/**
 * The row says there is a picture and the filesystem disagrees. A 500 rather than a 404,
 * because the two mean different things to an operator: a 404 is an account without an
 * avatar, this is storage that has lost one it was told to keep. `MeetingFilesService` names
 * the same condition for the same reason.
 */
export const AVATAR_OBJECT_MISSING = 'The avatar could not be read from storage';

export interface OpenedAvatar {
  contentType: string;
  /** Bytes, for `Content-Length`. */
  size: number;
  stream: ReadStream;
}

/**
 * The read side of the avatar. Writes are commands in `commands/handlers/`; this is the one
 * route that streams, and it reaches the database directly rather than over a bus because the
 * read does not leave the module — the same rule `MeetingFilesService` follows.
 *
 * **It takes a user id rather than assuming the caller**, which is what keeps the door open
 * for showing other people's avatars later: the route that exists today passes the token's
 * subject, and a second route could pass someone else's without this method changing. Today
 * there is no such route, so an account's avatar is visible to that account alone.
 */
@Injectable()
export class AvatarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: AvatarStorage,
  ) {}

  async openAvatar(userId: string): Promise<OpenedAvatar> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarKey: true },
    });

    // 404 for both "no such user" and "no avatar". They are the same answer to the one caller
    // there is — the route is `me`, so a missing user is an account deleted mid-request — and
    // distinguishing them on a future `/users/:id/avatar` would make that route an oracle for
    // which ids exist.
    if (user === null || user.avatarKey === null) {
      throw new NotFoundException(AVATAR_NOT_FOUND);
    }

    const { size } = await this.statObject(user.avatarKey);

    return {
      contentType: AVATAR_CONTENT_TYPE,
      size,
      stream: this.storage.openRead(user.avatarKey),
    };
  }

  /**
   * The object's size, or this module's own 500.
   *
   * `MEETING_FILES_DIR` is gitignored, so the storage tree goes missing in ways the rows do
   * not: a fresh clone, a container started without a volume, a developer clearing it by
   * hand. Without this, every read of an avatar whose bytes are gone answers with a raw
   * `ENOENT` — an unlabelled 500 carrying a filesystem path, and a stack trace in the log
   * where a named cause belongs. `MeetingFilesService.statObject` does exactly this.
   */
  private async statObject(key: string): Promise<{ size: number }> {
    try {
      return await this.storage.stat(key);
    } catch (error) {
      throw new InternalServerErrorException(AVATAR_OBJECT_MISSING, { cause: error });
    }
  }
}
