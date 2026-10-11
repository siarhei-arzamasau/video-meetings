import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { describeError } from '../../common/error-message';
import type { McpRequester, McpScope } from '../mcp-registry/mcp-scope';
import { McpToolRegistry } from '../mcp-registry/mcp-tool-registry';
import { FindVisibleMeetingQuery } from '../meetings/queries/find-visible-meeting.query';
import type { VisibleMeeting } from '../meetings/queries/find-visible-meeting.query';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './mcp.constants';

/** A meeting no row has: what the boot's rehearsal is registered for. */
const NO_MEETING_ID = '00000000-0000-0000-0000-000000000000';

/** The scope of a server nobody will ever connect to: no meeting, and a gate that is shut. */
const NOBODY: McpScope = {
  meetingId: NO_MEETING_ID,
  admit: () => Promise.resolve({ refusal: 'This server answers nobody.' }),
};

/**
 * The API as an MCP server over Streamable HTTP, built on `@modelcontextprotocol/sdk`
 * directly: an `McpServer` with everything in `McpToolRegistry` registered on it, joined to
 * a `StreamableHTTPServerTransport` that keeps no session (`sessionIdGenerator: undefined`)
 * and answers in JSON rather than as an event stream (`enableJsonResponse: true`).
 *
 * **It names no tool and no domain.** What the server offers is whatever the domain
 * modules `McpModule` imports have added to the registry, each from its own module.
 *
 * **A server and a transport are made for each request, not once as the module starts.**
 * A transport without sessions cannot tell one client from another, so two clients using
 * the same JSON-RPC id on one transport would be answered with each other's results. The
 * SDK therefore refuses a second request on a sessionless transport — it throws — and
 * refuses to connect a server that is already connected. One of each, made in
 * `onModuleInit`, answers exactly one request for the life of the process. Made per
 * request, the server can also be for one meeting and one user.
 *
 * **So `onModuleInit` is a rehearsal, and what it settles is real.** It goes through the
 * registry once, registering everything on a server that is then thrown away. That closes
 * the registry — a registrar that turns up later is refused, at boot, by name — and it is
 * where two domains claiming one tool name fail: as the process starts, not on the first
 * request somebody makes.
 *
 * **A request's server is made only for a user who can see the meeting**, the rule every
 * route here asks through `FindVisibleMeetingQuery` — the host and the participants. That
 * is the gate every registrar registers behind: decided once, as the request's server is
 * made, which is before every call and every read a sessionless request can carry.
 */
@Injectable()
export class McpService implements OnModuleInit {
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly registry: McpToolRegistry,
    private readonly queryBus: QueryBus,
  ) {}

  onModuleInit(): void {
    this.registry.registerAll(this.createServer(), NOBODY);
    this.logger.log(`MCP tools are registered by: ${this.registry.names().join(', ') || 'nobody'}`);
  }

  /**
   * A transport for one request, with a server of its own already connected to it: what
   * every domain registered, for `meetingId` and `requester`.
   *
   * A meeting that does not exist and one the requester is not in are one 404, as on every
   * route: which of the two it was is not the caller's to learn.
   */
  async openTransport(
    requester: McpRequester,
    meetingId: string,
  ): Promise<StreamableHTTPServerTransport> {
    const meeting = await this.queryBus.execute<FindVisibleMeetingQuery, VisibleMeeting | null>(
      new FindVisibleMeetingQuery(requester.userId, meetingId),
    );

    if (meeting === null) {
      throw new NotFoundException('Meeting not found');
    }

    const server = this.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // The id as the row holds it, not as the URL spelled it: a registrar may match a row
    // to its meeting as text.
    this.registry.registerAll(server, {
      meetingId: meeting.id,
      admit: () => Promise.resolve({ requester }),
    });
    await server.connect(transport);

    return transport;
  }

  /**
   * Lets go of a request's transport, and with it the server connected to it. It never
   * rejects: it runs when a response has closed, where nothing is left to answer.
   */
  async closeTransport(transport: StreamableHTTPServerTransport): Promise<void> {
    try {
      await transport.close();
    } catch (error) {
      this.logger.error('An MCP transport did not close cleanly', describeError(error));
    }
  }

  private createServer(): McpServer {
    return new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  }
}
