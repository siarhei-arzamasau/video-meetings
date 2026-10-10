import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { FindMeetingMemberIdsHandler } from './queries/handlers/find-meeting-member-ids.handler';
import { FindVisibleMeetingHandler } from './queries/handlers/find-visible-meeting.handler';

/**
 * The reads that cross out of the meetings module, and nothing else of it: whether a user
 * can see a meeting, and who is in one.
 *
 * They are a module of their own so that a root which only asks these can import them
 * without the meetings controller, or the credential routes and the rate limit
 * `MeetingsModule` brings with `AuthModule`. `MeetingsModule` imports it, so the API
 * answers them as it always has; nothing imports it alone today — the process it was split
 * out for, an MCP server on stdio, is gone.
 *
 * `@QueryHandler` registers nothing by itself: a handler missing from this array compiles
 * and only throws when the query is first dispatched.
 */
@Module({
  imports: [CqrsModule],
  providers: [FindVisibleMeetingHandler, FindMeetingMemberIdsHandler],
})
export class MeetingQueriesModule {}
