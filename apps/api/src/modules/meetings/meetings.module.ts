import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { AuthModule } from '../auth/auth.module';
import { CreateMeetingHandler } from './commands/handlers/create-meeting.handler';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './services/meetings.service';

@Module({
  // Imported per module rather than registered globally, so a module's `imports` states
  // what it actually needs. Every module that dispatches commands repeats this line.
  imports: [CqrsModule, AuthModule],
  controllers: [MeetingsController],
  // `@CommandHandler` registers nothing on its own: a handler missing from this array
  // compiles and only throws when the route is first hit.
  providers: [CreateMeetingHandler, MeetingsService],
})
export class MeetingsModule {}
