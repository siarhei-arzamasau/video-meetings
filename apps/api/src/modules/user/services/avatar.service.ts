import type { ReadStream } from 'node:fs';

import { Injectable, NotFoundException } from '@nestjs/common';
import { AVATAR_CONTENT_TYPE } from '@repo/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { AvatarStorage } from '../storage/avatar-storage';

export const AVATAR_NOT_FOUND = 'No avatar';

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

    const { size } = await this.storage.stat(user.avatarKey);

    return {
      contentType: AVATAR_CONTENT_TYPE,
      size,
      stream: this.storage.openRead(user.avatarKey),
    };
  }
}
