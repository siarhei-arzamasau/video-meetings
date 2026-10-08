import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import type { MeetingDigest, User } from '@repo/shared';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MeetingDigestsService } from './services/meeting-digests.service';

@Controller('meetings/:id/digest')
@UseGuards(JwtAuthGuard)
export class MeetingDigestsController {
  constructor(private readonly digests: MeetingDigestsService) {}

  /**
   * The meeting's digest, for anyone who can see the meeting. Always a 200 for them: a
   * meeting that never had a digest answers `version: 0` and nothing else, so a client has
   * one shape to read and no 404 to tell apart from "you may not see this meeting".
   *
   * A read inside the module, so it goes straight to the service — no `QueryBus`.
   */
  @Get()
  findOne(
    @CurrentUser() user: User,
    @Param('id', new ParseUUIDPipe({ version: '4' })) meetingId: string,
  ): Promise<MeetingDigest> {
    return this.digests.findOne(user.id, meetingId);
  }
}
