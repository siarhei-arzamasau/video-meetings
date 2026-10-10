import 'reflect-metadata';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';

import { StderrLogger } from './common/logging/stderr-logger';
import { MEETING_TOOLS_ACCESS_TOKEN_VARIABLE } from './config/env.validation.meeting-tools-stdio';
import {
  MEETING_TOOLS_STDIO_REFUSALS,
  MeetingToolsStdioAccess,
  MeetingToolsStdioAccessOutcome,
} from './modules/meeting-tools/stdio/meeting-tools-stdio.access';
import { MeetingToolsStdioModule } from './modules/meeting-tools/stdio/meeting-tools-stdio.module';
import { MeetingToolsStdioServer } from './modules/meeting-tools/stdio/meeting-tools-stdio.server';

const USAGE = `Usage: ${MEETING_TOOLS_ACCESS_TOKEN_VARIABLE}=<access-token> node dist/meeting-tools-stdio.main.js <meeting-id>\n`;
const LOG_CONTEXT = 'MeetingToolsStdio';

/**
 * The meeting's tasks as a process of its own: an MCP server on the stdio transport, started
 * by its client as a subprocess, bound to the one meeting named on its command line, and
 * answering for the one user whose access token is in its environment.
 *
 * **It does not start for a user who may not read the meeting.** The token is verified and
 * the meeting looked up before anything is served, so a client learns at once, on stderr
 * and by the exit code, that it holds a stale token or the wrong meeting — and not from a
 * tool that answers every call with an error. That check is made again on every call
 * (`MeetingToolsStdioServer`); this one is the same question asked early.
 *
 * **stdout belongs to the protocol.** Every frame the server sends is a line of JSON there,
 * so nothing else may write to it: the logger is `StderrLogger`, and what this file itself
 * has to say goes to stderr.
 */
async function bootstrap(): Promise<void> {
  // Lower-cased once: a stored id is, and a task is matched to its meeting as text.
  const meetingId = z.uuid().toLowerCase().safeParse(process.argv[2]);

  if (!meetingId.success) {
    process.stderr.write(USAGE);
    process.exitCode = 1;

    return;
  }

  const app = await NestFactory.createApplicationContext(MeetingToolsStdioModule, {
    logger: new StderrLogger(),
  });
  const accessToken = app
    .get(ConfigService)
    .getOrThrow<string>(MEETING_TOOLS_ACCESS_TOKEN_VARIABLE);
  const { outcome } = await app.get(MeetingToolsStdioAccess).check(accessToken, meetingId.data);

  if (outcome !== MeetingToolsStdioAccessOutcome.GRANTED) {
    process.stderr.write(`${MEETING_TOOLS_STDIO_REFUSALS[outcome]}\n`);
    process.exitCode = 1;
    await app.close();

    return;
  }

  await serve(app, app.get(MeetingToolsStdioServer).create(meetingId.data, accessToken));
}

/**
 * Connects the server to stdio, and sees to it that the process ends when its client does.
 *
 * **The transport does not see to that.** It listens for data on stdin and not for its end,
 * so a client that closes the pipe would leave this process holding a database connection
 * for good. Stdin ending, and either signal a client may send instead, close the server and
 * then the application — and with nothing left listening, the process exits.
 *
 * **And when the transport gives up by itself.** A frame too large to be one makes the
 * transport close and stop reading stdin, after which stdin's end is never seen: so the
 * server closing, for whatever reason, is a fourth way in. That is why closing is a flag set
 * first and not a promise kept: `server.close()` reports the close it has just made, to
 * this same function, before it returns.
 */
async function serve(app: INestApplicationContext, server: McpServer): Promise<void> {
  let closing = false;
  const close = (): void => {
    if (closing) {
      return;
    }

    closing = true;
    void server
      .close()
      .then(() => app.close())
      .then(() => Logger.log('The meeting tools server has closed', LOG_CONTEXT))
      .catch((error: unknown) => {
        Logger.error('The meeting tools server did not close cleanly', error, LOG_CONTEXT);
        process.exitCode = 1;
      });
  };

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's server is no EventTarget: `onclose` is the one callback it has
  server.server.onclose = close;
  process.stdin.once('end', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);

  await server.connect(new StdioServerTransport());
}

void bootstrap();
