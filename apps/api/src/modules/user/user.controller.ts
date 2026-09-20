import { Body, Controller, Patch, UseGuards } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { User } from '@repo/shared';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateDisplayNameCommand } from './commands/update-display-name.command';
import { UpdateDisplayNameDto } from './dto/update-display-name.dto';

/**
 * The user record's own routes. `me` is a literal segment, not a parameter: there is no route
 * here that takes a user id, so no route here can be asked to change somebody else. The
 * caller comes from the token and nowhere else.
 *
 * `GET /api/auth/me` stays where it is. It is served by the guard's lookup rather than by a
 * read of its own, and moving it here would cost a second query to answer a question the
 * request has already answered.
 */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly commandBus: CommandBus) {}

  /**
   * `PATCH`, not `PUT`: the body names the fields it changes and leaves the rest of the
   * record alone. Answers with the whole updated user, so a client that keeps the signed-in
   * user in memory can replace it without a follow-up `me`.
   */
  @Patch('me')
  updateDisplayName(
    @CurrentUser() user: User,
    @Body() { displayName }: UpdateDisplayNameDto,
  ): Promise<User> {
    return this.commandBus.execute<UpdateDisplayNameCommand, User>(
      new UpdateDisplayNameCommand(user.id, displayName),
    );
  }
}
