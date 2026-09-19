import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { MeetingFile, User } from '@repo/shared';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UploadMeetingFileCommand } from './commands/upload-meeting-file.command';
import { MeetingFilesService } from './services/meeting-files.service';
import { MeetingFileUploadInterceptor } from './storage/meeting-file-upload.interceptor';

export const FILE_REQUIRED_MESSAGE = 'A file is required';

const UUID_V4 = new ParseUUIDPipe({ version: '4' });

@Controller('meetings/:id/files')
@UseGuards(JwtAuthGuard)
export class MeetingFilesController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly files: MeetingFilesService,
  ) {}

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

  /** Reads go straight to the service — no `QueryBus`, by design. */
  @Get()
  findAll(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
  ): Promise<MeetingFile[]> {
    return this.files.findAll(user.id, meetingId);
  }
}
