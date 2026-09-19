import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import type { MeetingFile, User } from '@repo/shared';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MeetingFilesService } from './services/meeting-files.service';

const UUID_V4 = new ParseUUIDPipe({ version: '4' });

@Controller('meetings/:id/files')
@UseGuards(JwtAuthGuard)
export class MeetingFilesController {
  constructor(private readonly files: MeetingFilesService) {}

  /** Reads go straight to the service — no `QueryBus`, by design. */
  @Get()
  findAll(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
  ): Promise<MeetingFile[]> {
    return this.files.findAll(user.id, meetingId);
  }
}
