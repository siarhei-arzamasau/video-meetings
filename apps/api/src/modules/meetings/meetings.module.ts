import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { AuthModule } from '../auth/auth.module';
import { CreateMeetingHandler } from './commands/handlers/create-meeting.handler';
import { MeetingsController } from './meetings.controller';
import { FindMeetingMemberIdsHandler } from './queries/handlers/find-meeting-member-ids.handler';
import { FindVisibleMeetingHandler } from './queries/handlers/find-visible-meeting.handler';
import { MeetingsService } from './services/meetings.service';

@Module({
  // Imported per module rather than registered globally, so a module's `imports` states
  // what it actually needs. Every module that dispatches commands repeats this line.
  imports: [CqrsModule, AuthModule],
  controllers: [MeetingsController],
  // `@CommandHandler` registers nothing on its own: a handler missing from this array
  // compiles and only throws when the route is first hit.
  // The two query handlers answer the reads that cross out of this module: whether a user
  // can see a meeting, which every file and digest route dispatches instead of importing
  // this module, and who is in one, which the digest worker asks with no user at all.
  providers: [
    CreateMeetingHandler,
    FindVisibleMeetingHandler,
    FindMeetingMemberIdsHandler,
    MeetingsService,
  ],
})
export class MeetingsModule {}
