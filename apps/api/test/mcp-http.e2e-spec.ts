import request from 'supertest';

import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../src/modules/mcp/mcp.constants';
import { TaskService } from '../src/modules/tasks/services/task.service';
import { useApiSuite } from './utils/api-suite';
import { EMAIL } from './utils/fixtures';
import { MCP_ACCEPT, mcpUrl, postToMcp, withMcpClient } from './utils/mcp-client';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const TASK_TITLE = 'Rewrite the launch emails';

/**
 * The transport under the MCP server: what `/api/mcp` takes and refuses as HTTP, whatever
 * is registered on the server behind it. What the server offers, and to whom, is
 * `mcp-server.e2e-spec.ts`.
 */
describe('the MCP server over HTTP', () => {
  const suite = useApiSuite();
  const tasks = (): TaskService => suite.app().get(TaskService);

  it('says who it is, and answers one client after another and two at once', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    // A transport that keeps no session answers one request and refuses the next, so this
    // is the case that fails if the service ever holds one for the life of the process.
    await withMcpClient(suite, meeting.id, host, async ({ client }) => {
      expect(client.getServerVersion()).toMatchObject({
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      });
      await expect(client.ping()).resolves.toEqual({});
    });

    const pings: unknown[] = [];
    const ping = (): Promise<void> =>
      withMcpClient(suite, meeting.id, host, async ({ client }) => {
        pings.push(await client.ping());
      });

    await Promise.all([ping(), ping()]);

    expect(pings).toEqual([{}, {}]);
  });

  it('asks who is calling before anything else, the method included', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    await request(suite.app().getHttpServer()).get(mcpUrl(meeting.id)).expect(401);
    await request(suite.app().getHttpServer()).delete(mcpUrl(meeting.id)).expect(401);
    // Not even that the URL is wrong is said to somebody with no token.
    await postToMcp(suite, 'not-a-uuid', undefined).expect(401);
  });

  it.each([
    ['no meeting', undefined],
    ['a meeting id that is not one', 'not-a-uuid'],
  ])('refuses a URL with %s', async (_case, meetingId) => {
    const host = await registerUser(suite, EMAIL);

    await postToMcp(suite, meetingId, host.token).expect(400);
  });

  it.each(['get', 'delete'] as const)(
    'answers %s with a 405 instead of a stream nobody would write to',
    async (method) => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const agent = request(suite.app().getHttpServer());

      const answer = await agent[method](mcpUrl(meeting.id))
        .set('Accept', MCP_ACCEPT)
        .set('Authorization', `Bearer ${host.token}`)
        .expect(405);

      expect(answer.headers['allow']).toBe('POST');
      expect(answer.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32_000 }, id: null });
    },
  );

  it('refuses a batch at once, the one that would never be answered included', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const call = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'upsert_task', arguments: { title: TASK_TITLE } },
    };
    // A request with its own cancellation: the SDK answers neither, and a response that
    // waits for both would stay open until the client gave up — and hold a shutdown.
    const cancelled = [
      call,
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    ];

    const answer = await postToMcp(suite, meeting.id, host.token, cancelled)
      .timeout(5_000)
      .expect(400);

    expect(answer.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32_600 }, id: null });
    // Refused whole: no call in it ran.
    await expect(tasks().open(meeting.id)).resolves.toEqual([]);
  });

  it('answers a body that is not a message as a JSON-RPC error, not a 500', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const answer = await postToMcp(suite, meeting.id, host.token, { hello: 'world' }).expect(400);

    expect(answer.body).toMatchObject({ jsonrpc: '2.0', error: { code: expect.any(Number) } });
  });
});
