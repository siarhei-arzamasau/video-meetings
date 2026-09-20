import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  Sse,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { MeetingFile, User } from '@repo/shared';
import contentDisposition from 'content-disposition';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DeleteMeetingFileCommand } from './commands/delete-meeting-file.command';
import { RetryMeetingFileCommand } from './commands/retry-meeting-file.command';
import { UploadMeetingFileCommand } from './commands/upload-meeting-file.command';
import { MeetingFileEventsService } from './services/meeting-file-events.service';
import { MeetingFilesService } from './services/meeting-files.service';
import type { OpenedFile } from './services/meeting-files.service';
import { MeetingFileUploadInterceptor } from './storage/meeting-file-upload.interceptor';
import { VisibleMeetingGuard } from './visible-meeting.guard';

export const FILE_REQUIRED_MESSAGE = 'A file is required';

const UUID_V4 = new ParseUUIDPipe({ version: '4' });

@Controller('meetings/:id/files')
@UseGuards(JwtAuthGuard)
export class MeetingFilesController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly files: MeetingFilesService,
    private readonly fileEvents: MeetingFileEventsService,
  ) {}

  /**
   * This meeting's file changes as they happen: `event: file`, `data: <MeetingFile JSON>`,
   * `id: <ISO instant>`, with an `event: ping` every fifteen seconds so an idle stream is
   * not closed by a proxy and a dead one is detectable.
   *
   * Declared **before** the parameterised routes below so `files/events` is read as this
   * route and never as a file id — the same reason `MeetingFileUploadsController` is listed
   * first in the module.
   *
   * **Visibility is a guard here and an awaited call everywhere else**, and the difference is
   * not stylistic: Nest commits an SSE response's headers one macrotask after subscribing, so
   * a query awaited inside this handler loses the race and the 404 arrives as an `event:
   * error` on a 200 stream. `VisibleMeetingGuard` runs before any of that. The handler is
   * therefore synchronous, which is also what keeps it that way.
   *
   * The stream closes itself after `MEETING_FILES_STREAM_TTL_SECONDS`; reconnecting is the
   * client's job, and it refetches the list when it does.
   */
  @Sse('events')
  @UseGuards(VisibleMeetingGuard)
  events(@Param('id', UUID_V4) meetingId: string): Observable<MessageEvent> {
    return this.fileEvents.stream(meetingId);
  }

  /**
   * One file per request as `multipart/form-data`, field `file`. The interceptor has already
   * written it to the temp directory; the command carries its path and the handler owns it
   * from here.
   */
  @Post()
  @UseInterceptors(MeetingFileUploadInterceptor)
  upload(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<MeetingFile> {
    if (file === undefined) {
      throw new BadRequestException(FILE_REQUIRED_MESSAGE);
    }

    return this.commandBus.execute<UploadMeetingFileCommand, MeetingFile>(
      new UploadMeetingFileCommand(user.id, meetingId, file.originalname, file.path, file.size),
    );
  }

  /**
   * The original bytes as a download. The type is the record's sniffed one and `nosniff`
   * tells the browser not to second-guess it; together with `attachment`, a stored text file
   * that happens to hold HTML is never rendered. `content-disposition` handles the RFC 6266/5987
   * encoding of the display name, including `filename*` for anything outside Latin-1.
   */
  @Get(':fileId/content')
  async download(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
    @Param('fileId', UUID_V4) fileId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const opened = await this.files.openContent(user.id, meetingId, fileId);

    return stream(response, opened, 'attachment');
  }

  /** The WebP thumbnail, inline: it exists to be drawn in an `<img>`, never downloaded. */
  @Get(':fileId/thumbnail')
  async thumbnail(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
    @Param('fileId', UUID_V4) fileId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const opened = await this.files.openThumbnail(user.id, meetingId, fileId);

    return stream(response, opened, 'inline');
  }

  /**
   * Sends a `failed` file back through the pipeline, by the uploader or the host. The row
   * returns to `uploaded` and the worker claims it on its next tick; 200 rather than 201,
   * because nothing was created.
   */
  @Post(':fileId/retry')
  @HttpCode(200)
  retry(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
    @Param('fileId', UUID_V4) fileId: string,
  ): Promise<MeetingFile> {
    return this.commandBus.execute<RetryMeetingFileCommand, MeetingFile>(
      new RetryMeetingFileCommand(user.id, meetingId, fileId),
    );
  }

  /**
   * The transcript the pipeline wrote, inline as plain text. `nosniff` and `no-store` as for
   * every other stream here: what is served is the output of a third party, and a browser
   * must not be given the chance to decide it is something other than text.
   */
  @Get(':fileId/transcript')
  async transcript(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
    @Param('fileId', UUID_V4) fileId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const opened = await this.files.openTranscript(user.id, meetingId, fileId);

    return stream(response, opened, 'inline');
  }

  /** Soft delete by the uploader or the host; the worker purges the bytes later. */
  @Delete(':fileId')
  @HttpCode(204)
  remove(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
    @Param('fileId', UUID_V4) fileId: string,
  ): Promise<void> {
    return this.commandBus.execute<DeleteMeetingFileCommand, void>(
      new DeleteMeetingFileCommand(user.id, meetingId, fileId),
    );
  }

  /**
   * Reads go straight to the service — no `QueryBus`, by design. The bus this controller
   * does inject is for `FindVisibleMeetingQuery` above, which crosses a module boundary;
   * this one does not.
   */
  @Get()
  findAll(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
  ): Promise<MeetingFile[]> {
    return this.files.findAll(user.id, meetingId);
  }
}

/** The headers every streamed object gets; see `MeetingFilesService.openContent` for `size`. */
function stream(
  response: Response,
  opened: OpenedFile,
  type: 'attachment' | 'inline',
): StreamableFile {
  response.setHeader('Content-Type', opened.contentType);
  response.setHeader('Content-Length', String(opened.size));
  response.setHeader('Content-Disposition', contentDisposition(opened.name, { type }));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'private, no-store');

  return new StreamableFile(opened.stream);
}
