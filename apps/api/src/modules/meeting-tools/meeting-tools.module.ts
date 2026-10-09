import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { TasksModule } from '../tasks/tasks.module';
import { MeetingHooks } from './meeting-hooks';
import { MeetingTools } from './meeting-tools';

/**
 * The tools an agent may be given over the API's own data, and the hooks that bound a
 * run's use of them. `TasksModule` is imported for its service and `ClaudeAgentModule` for
 * the SDK's toolkit; the digest is reached over the command bus, as every module reaches
 * it, so `MeetingDigestsModule` is not.
 */
@Module({
  imports: [CqrsModule, ClaudeAgentModule, TasksModule],
  providers: [MeetingTools, MeetingHooks],
  exports: [MeetingTools, MeetingHooks],
})
export class MeetingToolsModule {}
