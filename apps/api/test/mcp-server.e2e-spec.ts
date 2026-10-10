import { TaskService } from '../src/modules/tasks/services/task.service';
import { useApiSuite } from './utils/api-suite';
import { EMAIL, OTHER_EMAIL, TEST_JWT_SECRET, THIRD_EMAIL } from './utils/fixtures';
import { messageOf } from './utils/http';
import { signJwtHmac } from './utils/jwt';
import { answerOf, postToMcp, withMcpClient } from './utils/mcp-client';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const NO_SUCH_TASK = 'There is no such task.';
const TASK_TITLE = 'Rewrite the launch emails';
const OPEN_TASKS = 'tasks://open';
const JSON_TYPE = 'application/json';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

const inAnHour = (): number => Math.floor(Date.now() / 1_000) + 60 * 60;

/**
 * The MCP server as its client meets it: `/api/mcp` of the running API, reached by the
 * SDK's own client the way Claude Code or any other is configured — a URL that names the
 * meeting and the user's access token in a header — against the API's real tokens and a
 * real database. Its tools, its resources, its prompts, and who it answers at all. The
 * token is what `POST /api/auth/register` answered with — the API's own, not one minted
 * here — except where the case is a token the API would never give.
 *
 * What is the transport's rather than the server's — one message per request, the methods
 * it takes, one client after another — is `mcp-http.e2e-spec.ts`.
 */
describe('the MCP server, for the user whose access token reaches it', () => {
  const suite = useApiSuite();
  const tasks = (): TaskService => suite.app().get(TaskService);

  it("keeps and finds a meeting's tasks for its host", async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    await withMcpClient(suite, meeting.id, host, async ({ client, callTool }) => {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
        'find_tasks',
        'upsert_task',
      ]);

      const created = await callTool('upsert_task', { title: TASK_TITLE });
      const task = { id: expect.any(String), title: TASK_TITLE, sourceMeetingId: meeting.id };

      expect(created.isError ?? false).toBe(false);
      expect(answerOf(created)).toEqual({ task: { ...task, status: 'OPEN' } });

      // The same title is the same task: its status moves, and no second task appears.
      await callTool('upsert_task', { title: TASK_TITLE, status: 'DONE' });

      expect(answerOf(await callTool('find_tasks', { query: 'launch emails' }))).toEqual({
        tasks: [{ ...task, status: 'DONE' }],
      });
    });
  });

  it('lists the open tasks at tasks://open, and reads one task of the meeting by its id', async () => {
    const host = await registerUser(suite, EMAIL);
    const other = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host);
    const elsewhere = await createMeeting(suite, other);
    const taskOf = (title: string, status: 'OPEN' | 'DONE', sourceMeetingId = meeting.id) =>
      tasks().upsert({ title, status, sourceMeetingId });
    const open = await taskOf('Book the venue', 'OPEN');
    const done = await taskOf('Print the badges', 'DONE');
    const foreign = await taskOf('Call Bob', 'OPEN', elsewhere.id);

    await withMcpClient(suite, meeting.id, host, async ({ client, readJson }) => {
      const { resources } = await client.listResources();
      const { resourceTemplates } = await client.listResourceTemplates();

      expect(resources.map(({ uri }) => uri)).toEqual([OPEN_TASKS]);
      expect(resourceTemplates.map(({ uriTemplate }) => uriTemplate)).toEqual(['task://{taskId}']);

      // Open, and this meeting's: neither the task that is done nor the other meeting's.
      await expect(readJson(OPEN_TASKS)).resolves.toEqual({
        mimeType: JSON_TYPE,
        json: {
          tasks: [{ id: open.id, title: open.title, status: 'OPEN', sourceMeetingId: meeting.id }],
        },
      });
      await expect(readJson(`task://${done.id}`)).resolves.toEqual({
        mimeType: JSON_TYPE,
        json: {
          task: { id: done.id, title: done.title, status: 'DONE', sourceMeetingId: meeting.id },
        },
      });
      // An id is its reader's to choose, and this one is a task of a meeting they are not in.
      await expect(readJson(`task://${foreign.id}`)).rejects.toThrow(NO_SUCH_TASK);
      await expect(readJson(`task://${UNKNOWN_ID}`)).rejects.toThrow(NO_SUCH_TASK);
    });
  });

  it('hands a client its prompts for gathering what is known about the meeting', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    await withMcpClient(suite, meeting.id, host, async ({ client }) => {
      const { prompts } = await client.listPrompts();
      const overview = await client.getPrompt({ name: 'meeting_overview' });
      const topic = await client.getPrompt({
        name: 'meeting_topic',
        arguments: { topic: 'launch emails' },
      });

      expect(prompts.map(({ name }) => name)).toEqual(['meeting_overview', 'meeting_topic']);
      // Each is one message of the user's, pointing at what this server itself serves.
      expect(overview.messages).toMatchObject([
        { role: 'user', content: { type: 'text', text: expect.stringContaining(OPEN_TASKS) } },
      ]);
      expect(topic.messages).toMatchObject([
        {
          role: 'user',
          content: { type: 'text', text: expect.stringContaining('"launch emails"') },
        },
      ]);
    });
  });

  it('answers a participant of the meeting as it answers its host', async () => {
    const host = await registerUser(suite, EMAIL);
    const participant = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [participant.id]);

    await withMcpClient(suite, meeting.id, participant, async ({ callTool }) => {
      await callTool('upsert_task', { title: TASK_TITLE });

      expect(answerOf(await callTool('find_tasks', { query: 'launch emails' }))).toMatchObject({
        tasks: [{ title: TASK_TITLE, sourceMeetingId: meeting.id }],
      });
    });
  });

  it("reaches no other meeting's tasks, whatever is sent beside a tool's arguments", async () => {
    const host = await registerUser(suite, EMAIL);
    const other = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host);
    const elsewhere = await createMeeting(suite, other);
    const foreign = await tasks().upsert({ title: 'Call Bob', sourceMeetingId: elsewhere.id });

    await withMcpClient(suite, meeting.id, host, async ({ callTool }) => {
      const found = await callTool('find_tasks', { query: 'Call Bob', meetingId: elsewhere.id });
      await callTool('upsert_task', {
        title: 'Call Bob',
        status: 'DONE',
        sourceMeetingId: elsewhere.id,
      });

      expect(answerOf(found)).toEqual({ tasks: [] });
    });

    // The write landed in the URL's meeting, as a task of its own; the other is untouched.
    await expect(tasks().get(foreign.id)).resolves.toMatchObject({ status: 'OPEN' });
    await expect(tasks().search('Call Bob', meeting.id)).resolves.toMatchObject([
      { title: 'Call Bob', status: 'DONE', sourceMeetingId: meeting.id },
    ]);
  });

  it('answers neither a user who is not in the meeting nor anyone for a meeting that does not exist', async () => {
    const host = await registerUser(suite, EMAIL);
    const stranger = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host);

    const refused = await postToMcp(suite, meeting.id, stranger.token).expect(404);
    const missing = await postToMcp(suite, UNKNOWN_ID, host.token).expect(404);

    // One answer for both: a stranger learns nothing from the difference.
    expect(messageOf(refused)).toBe('Meeting not found');
    expect(messageOf(missing)).toBe(messageOf(refused));
  });

  it("answers nobody on a token the API's key did not sign, has stopped honouring, or never gave", async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const claims = { sub: host.id, exp: inAnHour() };
    const refusedTokens = [
      signJwtHmac(claims, 'another-key-that-is-long-enough-to-be-one'),
      signJwtHmac({ sub: host.id, exp: inAnHour() - 2 * 60 * 60 }, TEST_JWT_SECRET),
      signJwtHmac(claims, TEST_JWT_SECRET, 'HS512'),
      // Signed by the right key, and good for ever: this API never issues one without an expiry.
      signJwtHmac({ sub: host.id }, TEST_JWT_SECRET),
      'not-a-token',
    ];

    const answers = await Promise.all(
      refusedTokens.map((token) => postToMcp(suite, meeting.id, token)),
    );

    expect(answers.map(({ status }) => status)).toEqual(refusedTokens.map(() => 401));
    await postToMcp(suite, meeting.id, undefined).expect(401);
  });

  it('stops answering a user who leaves the meeting while their client is connected', async () => {
    const host = await registerUser(suite, EMAIL);
    const participant = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [participant.id]);

    await withMcpClient(suite, meeting.id, participant, async ({ callTool, readJson }) => {
      expect((await callTool('find_tasks', { query: 'launch' })).isError ?? false).toBe(false);

      // Straight to the table: no route and no service takes a participant off a meeting yet.
      await suite.prisma().meetingParticipant.deleteMany({ where: { meetingId: meeting.id } });

      // Every request is checked, not the first one a client made: all of it is closed now.
      await expect(callTool('find_tasks', { query: 'launch' })).rejects.toThrow();
      await expect(callTool('upsert_task', { title: TASK_TITLE })).rejects.toThrow();
      await expect(readJson(OPEN_TASKS)).rejects.toThrow();
    });

    await postToMcp(suite, meeting.id, participant.token).expect(404);
    // Read as the tool would have written it: through the task service, and nothing is there.
    await expect(tasks().search(TASK_TITLE, meeting.id)).resolves.toEqual([]);
  });
});
