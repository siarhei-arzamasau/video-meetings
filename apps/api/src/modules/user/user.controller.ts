import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { User } from '@repo/shared';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DeleteAvatarCommand } from './commands/delete-avatar.command';
import { UpdateDisplayNameCommand } from './commands/update-display-name.command';
import { UploadAvatarCommand } from './commands/upload-avatar.command';
import { UpdateDisplayNameDto } from './dto/update-display-name.dto';
import { AvatarService } from './services/avatar.service';
import type { OpenedAvatar } from './services/avatar.service';
import { AvatarUploadInterceptor } from './storage/avatar-upload.interceptor';

export const AVATAR_REQUIRED_MESSAGE = 'A picture is required';

/**
 * The user record's own routes. `me` is a literal segment, not a parameter: there is no route
 * here that takes a user id, so no route here can be asked to change — or read — somebody
 * else. The caller comes from the token and nowhere else.
 *
 * `GET /api/auth/me` stays where it is. It is served by the guard's lookup rather than by a
 * read of its own, and moving it here would cost a second query to answer a question the
 * request has already answered.
 */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly avatars: AvatarService,
  ) {}

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

  /**
   * One image per request as `multipart/form-data`, field `avatar`. The interceptor has
   * already written it to the temp directory; the command carries its path and the handler
   * owns it from there.
   *
   * 200 rather than the 201 Nest gives a POST: an account has one avatar and this replaces it,
   * so nothing is created at a new address. It answers with the whole updated user, as the
   * `PATCH` above does, because the version it carries is what makes the new image appear.
   */
  @Post('me/avatar')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(AvatarUploadInterceptor)
  uploadAvatar(
    @CurrentUser() user: User,
    @UploadedFile() avatar?: Express.Multer.File,
  ): Promise<User> {
    if (avatar === undefined) {
      throw new BadRequestException(AVATAR_REQUIRED_MESSAGE);
    }

    return this.commandBus.execute<UploadAvatarCommand, User>(
      new UploadAvatarCommand(user.id, avatar.path, avatar.size),
    );
  }

  /**
   * The stored rendition, inline: it exists to be drawn, never downloaded. Always WebP and
   * always the same square, whatever was uploaded.
   *
   * `no-store`, like every other stream this API serves — and here it does a second job.
   * The path never changes, so a cached response would be an old avatar the browser had no
   * reason to re-request; `avatarVersion` on the user is what tells a client to fetch again,
   * and a cache would be free to ignore it.
   */
  @Get('me/avatar')
  async getAvatar(
    @CurrentUser() user: User,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return stream(response, await this.avatars.openAvatar(user.id));
  }

  /**
   * Removes the caller's avatar and answers with the updated user, so the page that asked can
   * fall back to initials without a second request. Idempotent: an account with none is a 200
   * and not a 404, because the state asked for is the state it is already in.
   */
  @Delete('me/avatar')
  deleteAvatar(@CurrentUser() user: User): Promise<User> {
    return this.commandBus.execute<DeleteAvatarCommand, User>(new DeleteAvatarCommand(user.id));
  }
}

/** The headers the avatar stream gets. `nosniff` because what is served is a file somebody
 *  uploaded, and a browser must not be given the chance to decide it is something else. */
function stream(response: Response, opened: OpenedAvatar): StreamableFile {
  response.setHeader('Content-Type', opened.contentType);
  response.setHeader('Content-Length', String(opened.size));
  response.setHeader('Content-Disposition', 'inline');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'private, no-store');

  return new StreamableFile(opened.stream);
}
