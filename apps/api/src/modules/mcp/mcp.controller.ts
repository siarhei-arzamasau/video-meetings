import {
  All,
  Controller,
  HttpStatus,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { McpRequester } from '../mcp-registry/mcp-scope';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpService } from './mcp.service';
import { Requester } from './requester.decorator';

const POST = 'POST';
const UUID_V4 = new ParseUUIDPipe({ version: '4' });

/** The SDK's own answer to a method a sessionless server has no use for. */
const METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0',
  error: { code: -32_000, message: 'Method not allowed.' },
  id: null,
};

/** JSON-RPC's "invalid request", for a body that is several messages instead of one. */
const BATCH_NOT_SUPPORTED = {
  jsonrpc: '2.0',
  error: { code: -32_600, message: 'Batches are not supported: send one message per request.' },
  id: null,
};

/**
 * `/api/mcp?meetingId=<id>`: one route for every method, handed to the SDK's transport,
 * which writes the response itself — hence `@Res` without passthrough, so Nest sends
 * nothing after it.
 *
 * **Behind `McpAuthGuard`**: the client sends the access token every other route takes, as
 * `Authorization: Bearer`, in its configuration's headers, and the guard leaves who it
 * names on the request. **The meeting is in the URL and never among a tool's arguments**:
 * fixed by whoever configured the client, out of reach of whatever a model sends.
 *
 * **Only `POST` reaches the transport.** In Streamable HTTP a `GET` opens an event stream
 * for what the server sends unasked, and `DELETE` ends a session. This server keeps no
 * session and sends nothing unasked, so a `GET` handed on would be a response held open
 * for nothing, and one more connection for a shutdown to wait on. Both are a 405, which a
 * client reads as "no stream here" and carries on without.
 *
 * **And only one message per request.** A body that is an array is a batch, and a batch can
 * hold a request together with the notification that cancels it. The SDK then answers
 * neither, and in JSON mode the response waits for an answer to every request in the body:
 * it never ends, and nothing ends it — not a timeout, not closing the transport — until the
 * client hangs up, with a shutdown waiting behind it. A batch is also a hundred tool calls
 * behind one check. The protocol dropped batches in 2025-06-18, and the SDK's client never
 * sends one.
 */
@Controller('mcp')
@UseGuards(McpAuthGuard)
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @All()
  async handle(
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
    @Requester() requester: McpRequester,
    @Query('meetingId', UUID_V4) meetingId: string,
  ): Promise<void> {
    if (req.method !== POST) {
      res.status(HttpStatus.METHOD_NOT_ALLOWED).set('Allow', POST).json(METHOD_NOT_ALLOWED);

      return;
    }

    if (Array.isArray(req.body)) {
      res.status(HttpStatus.BAD_REQUEST).json(BATCH_NOT_SUPPORTED);

      return;
    }

    const transport = await this.mcp.openTransport(requester, meetingId);

    if (res.destroyed) {
      // The client hung up while the meeting was looked up: `close` has been and gone, so
      // nothing would let go of the transport, and nobody is left to answer.
      await this.mcp.closeTransport(transport);

      return;
    }

    // The transport is this request's alone, so it goes when the response does — sent, or
    // abandoned by a client that hung up.
    res.once('close', () => void this.mcp.closeTransport(transport));

    await transport.handleRequest(req, res, req.body);
  }
}
