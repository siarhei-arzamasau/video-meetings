import { EventEmitter } from 'node:events';

import type { User } from '@repo/shared';
import type { Request, Response } from 'express';

import { McpController } from './mcp.controller';
import type { McpService } from './mcp.service';

/** As much of a response as the controller touches: what it sets, and that it closes. */
function fakeResponse(): Response & { status: jest.Mock; set: jest.Mock; json: jest.Mock } {
  const response = Object.assign(new EventEmitter(), {
    status: jest.fn(),
    set: jest.fn(),
    json: jest.fn(),
  });
  response.status.mockReturnValue(response);
  response.set.mockReturnValue(response);

  return response as unknown as Response & { status: jest.Mock; set: jest.Mock; json: jest.Mock };
}

const requestOf = (method: string, body?: object): Request => ({ method, body }) as Request;

const USER = { id: '11111111-1111-4111-8111-111111111111' } as User;
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

describe('McpController', () => {
  const handleRequest = jest.fn();
  const openTransport = jest.fn();
  const closeTransport = jest.fn();
  const transport = { handleRequest };
  const controller = new McpController({
    openTransport,
    closeTransport,
  } as unknown as McpService);

  beforeEach(() => {
    handleRequest.mockReset().mockResolvedValue(undefined);
    openTransport.mockReset().mockResolvedValue(transport);
    closeTransport.mockReset().mockResolvedValue(undefined);
  });

  it("hands a POST to a transport of its own: the request, the response, and the body Nest's parser read", async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const req = requestOf('POST', body);
    const res = fakeResponse();

    await controller.handle(req, res, USER, MEETING_ID);

    // For the user the guard let in and the meeting the URL names — nothing from the body.
    expect(openTransport).toHaveBeenCalledTimes(1);
    expect(openTransport).toHaveBeenCalledWith({ userId: USER.id }, MEETING_ID);
    expect(handleRequest).toHaveBeenCalledWith(req, res, body);
    // The transport writes the response; the controller writes nothing beside it.
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('opens a transport for each request', async () => {
    await controller.handle(requestOf('POST', {}), fakeResponse(), USER, MEETING_ID);
    await controller.handle(requestOf('POST', {}), fakeResponse(), USER, MEETING_ID);

    expect(openTransport).toHaveBeenCalledTimes(2);
  });

  it('lets go of the transport when the response closes, and not before', async () => {
    const res = fakeResponse();

    await controller.handle(requestOf('POST', {}), res, USER, MEETING_ID);

    expect(closeTransport).not.toHaveBeenCalled();

    res.emit('close');

    expect(closeTransport).toHaveBeenCalledWith(transport);
  });

  it('lets go of it all the same when the transport fails the request', async () => {
    const res = fakeResponse();
    handleRequest.mockRejectedValue(new Error('the body was not a message'));

    await expect(controller.handle(requestOf('POST', {}), res, USER, MEETING_ID)).rejects.toThrow();

    res.emit('close');

    expect(closeTransport).toHaveBeenCalledWith(transport);
  });

  it('refuses a body that is a batch, and opens no transport for it', async () => {
    const res = fakeResponse();
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_tasks' } },
      // The pair that is never answered: a request, and the notification that cancels it.
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    ];

    await controller.handle(requestOf('POST', batch), res, USER, MEETING_ID);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      error: { code: -32_600, message: expect.stringContaining('Batches are not supported') },
      id: null,
    });
    expect(openTransport).not.toHaveBeenCalled();
  });

  it('lets go of the transport at once for a client that hung up while it was opened', async () => {
    const res = Object.assign(fakeResponse(), { destroyed: true });

    await controller.handle(requestOf('POST', {}), res, USER, MEETING_ID);

    // `close` has already been emitted, so waiting for it would keep the transport for good.
    expect(closeTransport).toHaveBeenCalledWith(transport);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it('answers nothing itself when no transport is opened for the meeting', async () => {
    const res = fakeResponse();
    openTransport.mockRejectedValue(new Error('Meeting not found'));

    // The refusal is the service's to throw and the exception filter's to word.
    await expect(controller.handle(requestOf('POST', {}), res, USER, MEETING_ID)).rejects.toThrow(
      'Meeting not found',
    );
    expect(handleRequest).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it.each(['GET', 'DELETE', 'PUT', 'PATCH', 'HEAD'])(
    'answers %s with a 405 that names POST, and opens no transport for it',
    async (method) => {
      const res = fakeResponse();

      await controller.handle(requestOf(method), res, USER, MEETING_ID);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.set).toHaveBeenCalledWith('Allow', 'POST');
      expect(res.json).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        error: { code: -32_000, message: 'Method not allowed.' },
        id: null,
      });
      // A stream held open for a server that never sends anything is what this refuses.
      expect(openTransport).not.toHaveBeenCalled();
    },
  );
});
