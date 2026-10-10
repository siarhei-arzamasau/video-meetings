import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { MeetingDigest, User } from '@repo/shared';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RetryMeetingDigestCommand } from './commands/retry-meeting-digest.command';
import { MeetingDigestsService } from './services/meeting-digests.service';

const UUID_V4 = new ParseUUIDPipe({ version: '4' });

@Controller('meetings/:id/digest')
@UseGuards(JwtAuthGuard)
export class MeetingDigestsController {
  constructor(
    private readonly digests: MeetingDigestsService,
    private readonly commandBus: CommandBus,
  ) {}

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
    @Param('id', UUID_V4) meetingId: string,
  ): Promise<MeetingDigest> {
    return this.digests.findOne(user.id, meetingId);
  }

  /**
   * Retry: asks for a failed digest to be generated again, and answers it as the request
   * left it — `queued`. It takes no body, because there is nothing to choose: the digest is
   * of every transcribed recording. 200 rather than 201, as for a file's retry: nothing is
   * created that has an address of its own. The worker claims the row on its next tick.
   */
  @Post('generation')
  @HttpCode(200)
  retryGeneration(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
  ): Promise<MeetingDigest> {
    return this.commandBus.execute<RetryMeetingDigestCommand, MeetingDigest>(
      new RetryMeetingDigestCommand(user.id, meetingId),
    );
  }
}
