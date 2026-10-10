import 'reflect-metadata';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';

import { StderrLogger } from './common/logging/stderr-logger';
import { MeetingToolsStdioModule } from './modules/meeting-tools/stdio/meeting-tools-stdio.module';
import { MeetingToolsStdioServer } from './modules/meeting-tools/stdio/meeting-tools-stdio.server';

const USAGE = 'Usage: node dist/meeting-tools-stdio.main.js <meeting-id>\n';
const LOG_CONTEXT = 'MeetingToolsStdio';

/**
 * The meeting's tools as a process of its own: an MCP server on the stdio transport, started
 * by its client as a subprocess and bound to the one meeting named on its command line.
 *
 * **stdout belongs to the protocol.** Every frame the server sends is a line of JSON there,
 * so nothing else may write to it: the logger is `StderrLogger`, and what this file itself
 * has to say goes to stderr.
 *
 * **It ends when its client does.** The SDK's transport listens for data on stdin and not
 * for its end, so a client that closes the pipe would leave this process holding a database
 * connection for good. Stdin ending, and either signal a client may send instead, close the
 * server and then the application — and with nothing left listening, the process exits.
 *
 * **And when the transport gives up by itself.** A frame too large to be one makes the
 * transport close and stop reading stdin, after which stdin's end is never seen: so the
 * server closing, for whatever reason, is a fourth way in. That is why closing is a flag set
 * first and not a promise kept: `server.close()` reports the close it has just made, to
 * this same function, before it returns.
 */
async function bootstrap(): Promise<void> {
  const meetingId = z.uuid().safeParse(process.argv[2]);

  if (!meetingId.success) {
    process.stderr.write(USAGE);
    process.exitCode = 1;

    return;
  }

  const app = await NestFactory.createApplicationContext(MeetingToolsStdioModule, {
    logger: new StderrLogger(),
  });
  const server = app.get(MeetingToolsStdioServer).create(meetingId.data);
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
