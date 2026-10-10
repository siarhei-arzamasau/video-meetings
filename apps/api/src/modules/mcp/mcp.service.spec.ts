import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Logger, NotFoundException } from '@nestjs/common';
import type { QueryBus } from '@nestjs/cqrs';

import type { McpScope } from '../mcp-registry/mcp-scope';
import type { McpToolRegistrar } from '../mcp-registry/mcp-tool-registrar';
import { McpToolRegistry } from '../mcp-registry/mcp-tool-registry';
import { FindVisibleMeetingQuery } from '../meetings/queries/find-visible-meeting.query';
import { MCP_SERVER_NAME } from './mcp.constants';
import { McpService } from './mcp.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const REQUESTER = { userId: USER_ID };

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'spec', version: '0.0.0' },
  },
};

const initializeRequest = (): Request =>
  new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(INITIALIZE),
  });

/** A registrar that claims a name another may claim too. */
const claim = (server: McpServer): void => {
  server.registerTool('find_tasks', { description: 'x' }, () => ({ content: [] }));
};

describe('McpService', () => {
  const register = jest.fn<void, [McpServer, McpScope]>();
  const execute = jest.fn();
  let registry: McpToolRegistry;
  let service: McpService;

  /** A domain's registrar, as the registry holds one. */
  class DomainTools implements McpToolRegistrar {
    register = register;
  }

  beforeEach(() => {
    register.mockReset();
    execute.mockReset().mockResolvedValue({ id: MEETING_ID, hostId: USER_ID });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    registry = new McpToolRegistry();
    registry.add(new DomainTools());
    service = new McpService(registry, { execute } as unknown as QueryBus);
  });

  describe('as its module starts', () => {
    it('has every registrar in the registry register on a server, for a scope that lets nobody in', async () => {
      service.onModuleInit();

      const [server, scope] = register.mock.calls[0] ?? [];

      expect(register).toHaveBeenCalledTimes(1);
      expect(server).toBeInstanceOf(McpServer);
      // A rehearsal: that server is thrown away, and its gate is shut all the same.
      await expect(scope?.admit()).resolves.toEqual({ refusal: expect.any(String) });
    });

    it('closes the registry, so a registrar that comes late is refused by name', () => {
      service.onModuleInit();

      // The order going wrong is an error at boot, not a tool missing from every server.
      expect(() => registry.add(new DomainTools())).toThrow(
        /DomainTools was added .* after a server/,
      );
    });

    it('fails there, not on a request, when two registrars claim one tool', () => {
      registry = new McpToolRegistry();
      registry.add({ register: claim });
      registry.add({ register: claim });
      service = new McpService(registry, { execute } as unknown as QueryBus);

      expect(() => service.onModuleInit()).toThrow(/find_tasks/);
    });

    it('says in the log whose tools it offers', () => {
      service.onModuleInit();

      expect(Logger.prototype.log).toHaveBeenCalledWith(expect.stringContaining('DomainTools'));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens a transport that keeps no session, with a server already connected to it', async () => {
    const transport = await service.openTransport(REQUESTER, MEETING_ID);

    expect(transport.sessionId).toBeUndefined();
    // Connecting is what gives a transport somebody to hand a message to.
    expect(transport.onmessage).toBeInstanceOf(Function);

    await service.closeTransport(transport);
  });

  it('opens another for every request, never the one it opened before', async () => {
    const first = await service.openTransport(REQUESTER, MEETING_ID);
    const second = await service.openTransport(REQUESTER, MEETING_ID);

    expect(second).not.toBe(first);

    await Promise.all([service.closeTransport(first), service.closeTransport(second)]);
  });

  it("has every registrar register on the request's server, for the meeting and the requester", async () => {
    const transport = await service.openTransport(REQUESTER, MEETING_ID);
    const [server, scope] = register.mock.calls[0] ?? [];

    expect(register).toHaveBeenCalledTimes(1);
    expect(server).toBeInstanceOf(McpServer);
    expect(server?.server.getClientVersion()).toBeUndefined();
    expect(scope?.meetingId).toBe(MEETING_ID);
    // The gate the tools are behind: whoever the route let in, for the life of the request.
    await expect(scope?.admit()).resolves.toEqual({ requester: REQUESTER });
    expect(MCP_SERVER_NAME).toBe('video-meetings');

    await service.closeTransport(transport);
  });

  it('asks whether the requester can see the meeting, and registers for the id the row holds', async () => {
    const asGiven = MEETING_ID.toUpperCase();

    const transport = await service.openTransport(REQUESTER, asGiven);

    expect(execute).toHaveBeenCalledWith(new FindVisibleMeetingQuery(USER_ID, asGiven));
    // A task is matched to its meeting as text, so the URL's spelling must not be what is kept.
    expect(register.mock.calls[0]?.[1].meetingId).toBe(MEETING_ID);

    await service.closeTransport(transport);
  });

  it('opens nothing for a meeting the requester cannot see, or that does not exist', async () => {
    execute.mockResolvedValue(null);

    await expect(service.openTransport(REQUESTER, MEETING_ID)).rejects.toThrow(
      new NotFoundException('Meeting not found'),
    );
    // No server was made, so nothing was registered for anybody.
    expect(register).not.toHaveBeenCalled();
  });

  it('closes a transport without rejecting when the close itself fails', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const transport = await service.openTransport(REQUESTER, MEETING_ID);
    jest.spyOn(transport, 'close').mockRejectedValue(new Error('already gone'));

    // It runs when a response has closed: a rejection there has nobody to reach.
    await expect(service.closeTransport(transport)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
  });

  /**
   * Why there is a transport per request, pinned against the SDK itself rather than
   * believed: the transport this service builds, with its options, answers once. The day
   * this fails the SDK has changed its mind, and one transport for the process — what the
   * module was first asked to hold — becomes possible again.
   */
  it('could not answer a second request on one sessionless transport: the SDK refuses', async () => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await new McpServer({ name: 'spec', version: '0.0.0' }).connect(transport);

    await expect(transport.handleRequest(initializeRequest())).resolves.toMatchObject({
      status: 200,
    });
    await expect(transport.handleRequest(initializeRequest())).rejects.toThrow(
      'Stateless transport cannot be reused across requests',
    );

    await transport.close();
  });
});
