import { MEETING_TOOLS_ACCESS_TOKEN_VARIABLE } from '../src/config/env.validation.meeting-tools-stdio';
import { TaskService } from '../src/modules/tasks/services/task.service';
import { useApiSuite } from './utils/api-suite';
import { EMAIL, OTHER_EMAIL, TEST_JWT_SECRET, THIRD_EMAIL } from './utils/fixtures';
import { signJwtHmac } from './utils/jwt';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import {
  CONNECTED,
  NO_ACCESS_TOKEN,
  answerOf,
  runServer,
  withMcpClient,
} from './utils/meeting-tools-stdio';

const TOKEN_REFUSED = 'The access token was refused';
const NO_SUCH_MEETING = 'There is no such meeting for the user the access token names.';
const NO_SUCH_TASK = 'There is no such task.';
const TASK_TITLE = 'Rewrite the launch emails';
const OPEN_TASKS = 'tasks://open';
const JSON_TYPE = 'application/json';

// A start compiles the server's module graph before anything answers.
jest.setTimeout(60_000);

const inAnHour = (): number => Math.floor(Date.now() / 1_000) + 60 * 60;

/**
 * The MCP server as its client meets it: started as a subprocess with a user's access
 * token, as Claude Code or any other client would start it, against the API's real tokens
 * and a real database — its tools, its resources, its prompts, and who it answers at all.
 * The token is what `POST /api/auth/register` answered with — the API's own, not one minted
 * here — except where the case is a token the API would never give.
 */
describe('the MCP server, for the user whose access token starts it', () => {
  const suite = useApiSuite();
  const tasks = (): TaskService => suite.app().get(TaskService);

  it("keeps and finds a meeting's tasks for its host", async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    await withMcpClient(meeting.id, host.token, async ({ callTool }) => {
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

    await withMcpClient(meeting.id, host.token, async ({ client, readJson }) => {
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
      await expect(readJson('task://99999999-9999-4999-8999-999999999999')).rejects.toThrow(
        NO_SUCH_TASK,
      );
    });
  });

  it('hands a client its prompts for gathering what is known about the meeting', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    await withMcpClient(meeting.id, host.token, async ({ client }) => {
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

    await withMcpClient(meeting.id, participant.token, async ({ callTool }) => {
      await callTool('upsert_task', { title: TASK_TITLE });

      expect(answerOf(await callTool('find_tasks', { query: 'launch emails' }))).toMatchObject({
        tasks: [{ title: TASK_TITLE, sourceMeetingId: meeting.id }],
      });
    });
  });

  it('does not start for a user who is not in the meeting, or for a meeting that does not exist', async () => {
    const host = await registerUser(suite, EMAIL);
    const stranger = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host);

    const refused = await runServer([meeting.id], stranger.token);
    const missing = await runServer(['99999999-9999-4999-8999-999999999999'], host.token);

    // One answer for both, as one 404 on a route: a stranger learns nothing from the difference.
    for (const ended of [refused, missing]) {
      expect(ended).toMatchObject({ code: 1, signal: null, stdout: '' });
      expect(ended.stderr).toContain(NO_SUCH_MEETING);
    }
  });

  it("does not start on a token the API's key did not sign, has stopped honouring, or never gave", async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const claims = { sub: host.id, exp: inAnHour() };
    const refusedTokens = [
      signJwtHmac(claims, 'another-key-that-is-long-enough-to-be-one'),
      signJwtHmac({ sub: host.id, exp: inAnHour() - 2 * 60 * 60 }, TEST_JWT_SECRET),
      signJwtHmac(claims, TEST_JWT_SECRET, 'HS512'),
      'not-a-token',
    ];

    const attempts = await Promise.all(
      refusedTokens.map(async (token) => ({ token, ended: await runServer([meeting.id], token) })),
    );

    for (const { token, ended } of attempts) {
      expect(ended).toMatchObject({ code: 1, signal: null, stdout: '' });
      expect(ended.stderr).toContain(TOKEN_REFUSED);
      // What was refused is never repeated, on a stream a client may show or keep.
      expect(ended.stderr).not.toContain(token);
    }
  });

  it('does not start with no token, and names the variable one goes in', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const ended = await runServer([meeting.id], NO_ACCESS_TOKEN);

    expect(ended.code).not.toBe(0);
    expect(ended.stdout).toBe('');
    expect(ended.stderr).toContain(MEETING_TOOLS_ACCESS_TOKEN_VARIABLE);
    // It never got as far as the database.
    expect(ended.stderr).not.toContain(CONNECTED);
  });

  it('stops answering a user who leaves the meeting while the server is up', async () => {
    const host = await registerUser(suite, EMAIL);
    const participant = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [participant.id]);

    await withMcpClient(meeting.id, participant.token, async ({ callTool, readJson }) => {
      expect((await callTool('find_tasks', { query: 'launch' })).isError ?? false).toBe(false);

      // Straight to the table: no route and no service takes a participant off a meeting yet.
      await suite.prisma().meetingParticipant.deleteMany({ where: { meetingId: meeting.id } });

      // Checked on every call, not once as the process started: tools and resources are closed.
      const answers = await Promise.all([
        callTool('find_tasks', { query: 'launch' }),
        callTool('upsert_task', { title: TASK_TITLE }),
      ]);

      for (const answer of answers) {
        expect(answer.isError).toBe(true);
        expect(answer.content[0]?.text).toBe(NO_SUCH_MEETING);
      }
      await expect(readJson(OPEN_TASKS)).rejects.toThrow(NO_SUCH_MEETING);
      // Read as the tool would have written it: through the task service, and nothing is there.
      await expect(tasks().search(TASK_TITLE, meeting.id)).resolves.toEqual([]);
    });
  });
});
