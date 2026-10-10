import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ENV_FILE_PATHS } from '../../../config/env-values';
import { PrismaModule } from '../../prisma/prisma.module';
import { TasksModule } from '../../tasks/tasks.module';
import { MeetingToolsStdioServer } from './meeting-tools-stdio.server';

/**
 * The root module of the process that serves the meeting's tools over stdio —
 * `src/meeting-tools-stdio.main.ts` — and of nothing else. It is not in `AppModule`.
 *
 * **Everything the tool needs and nothing more**: the database, and `TasksModule` for the
 * search. Not `MeetingToolsModule`, whose in-process server brings the Claude toolkit and
 * the command bus with it — a process that only searches tasks has no use for a way to
 * start Claude.
 *
 * **The environment is read from the API's files and not held to the API's contract.** The
 * one variable this process needs is `DATABASE_URL`, which `PrismaService` refuses to start
 * without. The contract in `env.validation.ts` is the API's: holding a task search to it
 * would refuse to start over a signing key or an upload directory it never touches.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, envFilePath: ENV_FILE_PATHS }),
    PrismaModule,
    TasksModule,
  ],
  providers: [MeetingToolsStdioServer],
})
export class MeetingToolsStdioModule {}
