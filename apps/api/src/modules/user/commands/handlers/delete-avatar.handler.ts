import { Logger, UnauthorizedException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import type { User } from '@repo/shared';

import { errorMessage } from '../../../../common/error-message';
import { isRecordNotFound } from '../../../prisma/prisma-errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { toPublicUser } from '../../services/user.mapper';
import { AvatarStorage } from '../../storage/avatar-storage';
import { DeleteAvatarCommand } from '../delete-avatar.command';

/**
 * Removes the caller's avatar, and answers with the whole updated user so a client holding the
 * signed-in user can replace it without a follow-up read.
 *
 * **The row is cleared before the bytes are.** That order is the one the PRD's rule needs: the
 * previous URL must stop working, and it stops working the moment the reference is gone. A
 * failed unlink afterwards leaves an object nothing points at — a few kilobytes, logged — where
 * the reverse order would leave a row pointing at a file that is not there, and a 500 on every
 * read of it.
 *
 * **The key removed is read in the transaction that clears it, not in the lookup above.** An
 * upload running alongside this one writes its own key and points the row at it; clearing on
 * what was read a moment earlier would unlink whichever object the row happened to name then,
 * and that may be the one the upload has just published.
 *
 * **Idempotent**: an account with no avatar is returned unchanged, version included. Bumping
 * it would tell every client to re-fetch an image that did not change, and "remove what is
 * already not there" is a request that has already succeeded.
 */
@CommandHandler(DeleteAvatarCommand)
export class DeleteAvatarHandler implements ICommandHandler<DeleteAvatarCommand, User> {
  private readonly logger = new Logger(DeleteAvatarHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: AvatarStorage,
  ) {}

  async execute({ userId }: DeleteAvatarCommand): Promise<User> {
    const current = await this.prisma.user.findUnique({ where: { id: userId } });

    if (current === null) {
      throw new UnauthorizedException();
    }

    if (current.avatarKey === null) {
      return toPublicUser(current);
    }

    const { user, removedKey } = await this.clearAvatar(userId);

    if (removedKey !== null) {
      try {
        await this.storage.remove(removedKey);
      } catch (error) {
        // The reference is already gone, so the avatar is removed as far as every caller is
        // concerned. What is left is an unreferenced object, which is worth a line in the log
        // and not worth failing a request that succeeded.
        this.logger.warn(
          `Could not remove the avatar object for ${userId}: ${errorMessage(error)}`,
        );
      }
    }

    return user;
  }

  /** Clears the reference and reports the key it was holding at that moment, which is the one
   *  object this request is entitled to remove. */
  private async clearAvatar(userId: string): Promise<{ user: User; removedKey: string | null }> {
    try {
      const [previous, user] = await this.prisma.$transaction([
        this.prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } }),
        this.prisma.user.update({
          where: { id: userId },
          // The version moves even though the avatar is gone: a client caching by it has to
          // learn that what it holds is no longer what the account has.
          data: { avatarKey: null, avatarVersion: { increment: 1 } },
        }),
      ]);

      return { user: toPublicUser(user), removedKey: previous?.avatarKey ?? null };
    } catch (error) {
      if (isRecordNotFound(error)) {
        throw new UnauthorizedException();
      }

      throw error;
    }
  }
}
