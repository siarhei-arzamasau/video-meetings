import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { AuthModule } from '../auth/auth.module';
import { CreateMeetingHandler } from './commands/handlers/create-meeting.handler';
import { MeetingQueriesModule } from './meeting-queries.module';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './services/meetings.service';

@Module({
  // Imported per module rather than registered globally, so a module's `imports` states
  // what it actually needs. Every module that dispatches commands repeats this line.
  // `MeetingQueriesModule` holds the two reads that cross out of this module — whether a
  // user can see a meeting, which every file and digest route dispatches instead of
  // importing this module, and who is in one, which the digest worker asks with no user at
  // all — apart from the rest, for the process that needs those and nothing else here.
  imports: [CqrsModule, AuthModule, MeetingQueriesModule],
  controllers: [MeetingsController],
  // `@CommandHandler` registers nothing on its own: a handler missing from this array
  // compiles and only throws when the route is first hit.
  providers: [CreateMeetingHandler, MeetingsService],
})
export class MeetingsModule {}
