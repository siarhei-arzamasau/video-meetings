import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { Meeting, User } from '@repo/shared';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateMeetingCommand } from './commands/create-meeting.command';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { MeetingsService } from './services/meetings.service';

@Controller('meetings')
@UseGuards(JwtAuthGuard)
export class MeetingsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly meetings: MeetingsService,
  ) {}

  /** Destructures the DTO: the command carries primitives, never the transport object. */
  @Post()
  create(
    @CurrentUser() user: User,
    @Body() { title, scheduledAt, participantIds }: CreateMeetingDto,
  ): Promise<Meeting> {
    return this.commandBus.execute<CreateMeetingCommand, Meeting>(
      new CreateMeetingCommand(user.id, title, scheduledAt, participantIds),
    );
  }

  /** Reads go straight to the service — no `QueryBus`, by design. */
  @Get()
  findAll(@CurrentUser() user: User): Promise<Meeting[]> {
    return this.meetings.findAll(user.id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: User,
    @Param('id', new ParseUUIDPipe({ version: '4' })) meetingId: string,
  ): Promise<Meeting> {
    return this.meetings.findOne(user.id, meetingId);
  }
}
