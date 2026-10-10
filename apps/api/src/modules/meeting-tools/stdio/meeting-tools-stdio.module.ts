import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';

import { ENV_FILE_PATHS } from '../../../config/env-values';
import { validateMeetingToolsStdio } from '../../../config/env.validation.meeting-tools-stdio';
import { AccessTokenModule } from '../../auth/access-token.module';
import { MeetingQueriesModule } from '../../meetings/meeting-queries.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { TasksModule } from '../../tasks/tasks.module';
import { MeetingToolsStdioAccess } from './meeting-tools-stdio.access';
import { MeetingToolsStdioServer } from './meeting-tools-stdio.server';

/**
 * The root module of the process that serves the meeting's tools over stdio —
 * `src/meeting-tools-stdio.main.ts` — and of nothing else. It is not in `AppModule`.
 *
 * **Everything the tool needs and nothing more**: the database, `TasksModule` for the
 * search, and the two narrow modules that decide who may ask — `AccessTokenModule`, which
 * verifies a token, and `MeetingQueriesModule`, which says whether its user can see the
 * meeting. Not `AuthModule` or `MeetingsModule`, which would bring the credential routes,
 * argon2 and the rate limit into a process with no routes; and not `MeetingToolsModule`,
 * whose in-process server brings the Claude toolkit and the command bus — a process that
 * only searches tasks has no use for a way to sign a user in or to start Claude.
 *
 * **The environment is read from the API's files and held to a contract of its own**
 * (`env.validation.meeting-tools-stdio.ts`): the database, the signing key, the client's
 * token. The API's contract would refuse to start over an upload directory or an origin
 * this process never touches.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ENV_FILE_PATHS,
      validate: validateMeetingToolsStdio,
    }),
    CqrsModule,
    PrismaModule,
    AccessTokenModule,
    MeetingQueriesModule,
    TasksModule,
  ],
  providers: [MeetingToolsStdioAccess, MeetingToolsStdioServer],
})
export class MeetingToolsStdioModule {}
