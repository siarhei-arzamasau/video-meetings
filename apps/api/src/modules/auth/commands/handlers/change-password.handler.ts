import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { CommandBus, CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';
import {
  CURRENT_PASSWORD_MESSAGE,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_UNCHANGED_MESSAGE,
} from '@repo/shared';

import { UpdatePasswordHashCommand } from '../../../user/commands/update-password-hash.command';
import { FindUserCredentialsByIdQuery } from '../../../user/queries/find-user-credentials-by-id.query';
import type { UserCredentials } from '../../../user/queries/user-credentials';
import { PasswordService } from '../../services/password.service';
import { ChangePasswordCommand } from '../change-password.command';

/** What `RegisterDto` says about a password that is nothing but whitespace, restated as the
 *  use case's own rule. */
export const NEW_PASSWORD_MESSAGE = `Your new password must be ${String(MIN_PASSWORD_LENGTH)}–${String(MAX_PASSWORD_LENGTH)} characters and contain something other than spaces.`;

/**
 * Rotating a password, which is two modules meeting exactly as registration is: auth verifies
 * the old credential and hashes the new one, `user` owns the row in between, and the only
 * things that cross are command and query classes.
 *
 * The order of the checks is the point of the handler.
 *
 * 1. **The new password's bounds first**, because they are not a secret: the caller typed that
 *    value and the DTO already refused it once. Checking it here as well is the rule this use
 *    case owns — a command has to be safe whatever dispatched it.
 * 2. **Then the current password**, which is the whole authorisation. A miss is a 401 carrying
 *    `CURRENT_PASSWORD_MESSAGE` and nothing else, the shape a failed login has.
 * 3. **Then "is this actually a change?"**, which is asked last on purpose: answering it
 *    before step 2 would tell someone holding a stolen token whether a guessed password is
 *    the account's current one, which is the one fact this endpoint must not hand out.
 */
@CommandHandler(ChangePasswordCommand)
export class ChangePasswordHandler implements ICommandHandler<ChangePasswordCommand, void> {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly passwords: PasswordService,
  ) {}

  async execute({ userId, currentPassword, newPassword }: ChangePasswordCommand): Promise<void> {
    assertUsableNewPassword(newPassword);

    const user = await this.queryBus.execute<FindUserCredentialsByIdQuery, UserCredentials | null>(
      new FindUserCredentialsByIdQuery(userId),
    );

    if (user === null) {
      // The token names an account that is gone. The guard's own rule, one step later — the
      // same answer `UpdateDisplayNameHandler` gives the same race.
      throw new UnauthorizedException();
    }

    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException(CURRENT_PASSWORD_MESSAGE);
    }

    // A string comparison, not a second `verify`: step 2 has just established that
    // `currentPassword` is the account's password, so two equal strings are one password.
    if (newPassword === currentPassword) {
      throw new BadRequestException(PASSWORD_UNCHANGED_MESSAGE);
    }

    const passwordHash = await this.passwords.hash(newPassword);

    await this.commandBus.execute<UpdatePasswordHashCommand, void>(
      new UpdatePasswordHashCommand(userId, passwordHash),
    );
  }
}

/** `RegisterDto`'s rules as an invariant of this use case, so the command is safe whatever
 *  dispatched it. One message for every way the value fails, as the display name has. */
function assertUsableNewPassword(newPassword: string): void {
  const isWithinBounds =
    newPassword.length >= MIN_PASSWORD_LENGTH && newPassword.length <= MAX_PASSWORD_LENGTH;

  if (!isWithinBounds || !/\S/.test(newPassword)) {
    throw new BadRequestException(NEW_PASSWORD_MESSAGE);
  }
}
