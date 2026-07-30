import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { Meeting, User } from '@repo/shared';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { MeetingsService } from './meetings.service';

@Controller('meetings')
@UseGuards(JwtAuthGuard)
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateMeetingDto): Promise<Meeting> {
    return this.meetings.create(user.id, dto);
  }

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
