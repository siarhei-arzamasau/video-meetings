import { TaskService } from '../src/modules/tasks/services/task.service';
import { MAX_TASKS_PER_OWNER } from '../src/modules/tasks/task.constants';
import { useApiSuite } from './utils/api-suite';
import { EMAIL, OTHER_EMAIL } from './utils/fixtures';
import { answerOf, withMcpClient } from './utils/mcp-client';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const TASK_TITLE = 'Rewrite the launch emails';
const OPEN_TASKS = 'tasks://open';
const FORBIDDEN = 403;

/**
 * Whose tasks the MCP server answers with: two members of one meeting, each with a client
 * of their own, each writing their own tasks and reading those and the ones nobody owns —
 * and never the other's. An id or an owner among a request's arguments says what to look
 * for — never who may see it.
 */
describe('the MCP server, for two members of one meeting', () => {
  const suite = useApiSuite();
  const tasks = (): TaskService => suite.app().get(TaskService);
  const members = async () => {
    const host = await registerUser(suite, EMAIL);
    const participant = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [participant.id]);

    return { host, participant, meeting };
  };

  it('writes a task as the user who is asking, whoever a caller names as its owner', async () => {
    const { host, participant, meeting } = await members();

    await withMcpClient(suite, meeting.id, participant, async ({ callTool }) => {
      const created = await callTool('upsert_task', {
        title: TASK_TITLE,
        ownerId: host.id,
        userId: host.id,
        requester: { userId: host.id },
      });
      const { task } = answerOf(created) as { task: { id: string } };

      await expect(tasks().get(task.id)).resolves.toMatchObject({ ownerId: participant.id });
    });
  });

  it("finds and lists a member's own tasks, and none of another member's", async () => {
    const { host, participant, meeting } = await members();

    await withMcpClient(suite, meeting.id, host, async ({ callTool }) => {
      await callTool('upsert_task', { title: TASK_TITLE });
    });

    await withMcpClient(suite, meeting.id, participant, async ({ callTool, readJson }) => {
      const found = await callTool('find_tasks', { query: 'launch emails', ownerId: host.id });

      expect(answerOf(found)).toEqual({ tasks: [] });
      await expect(readJson(OPEN_TASKS)).resolves.toMatchObject({ json: { tasks: [] } });
    });

    await withMcpClient(suite, meeting.id, host, async ({ callTool, readJson }) => {
      const found = await callTool('find_tasks', { query: 'launch emails' });
      const mine = { tasks: [{ title: TASK_TITLE, status: 'OPEN', mine: true }] };

      expect(answerOf(found)).toMatchObject(mine);
      await expect(readJson(OPEN_TASKS)).resolves.toMatchObject({ json: mine });
    });
  });

  it("gives a member a task of their own under a title another member's task has", async () => {
    const { host, participant, meeting } = await members();
    const ofHost = await tasks().upsert({
      title: TASK_TITLE,
      sourceMeetingId: meeting.id,
      ownerId: host.id,
    });

    await withMcpClient(suite, meeting.id, participant, async ({ callTool }) => {
      const written = await callTool('upsert_task', { title: TASK_TITLE, status: 'DONE' });

      expect(answerOf(written)).toMatchObject({ task: { status: 'DONE' } });
      expect(answerOf(written)).not.toMatchObject({ task: { id: ofHost.id } });
    });

    // The same title was no way into the host's task: it stands as it stood.
    await expect(tasks().get(ofHost.id)).resolves.toMatchObject({ status: 'OPEN' });
  });

  it("refuses a read of another member's task by its id as forbidden, and answers nobody's", async () => {
    const { host, participant, meeting } = await members();
    const sourceMeetingId = meeting.id;
    const ofHost = await tasks().upsert({ title: TASK_TITLE, sourceMeetingId, ownerId: host.id });
    // A task nobody owns, as a digest's generation writes one.
    const ofNobody = await tasks().upsert({ title: 'Book the venue', sourceMeetingId });

    await withMcpClient(suite, meeting.id, participant, async ({ readJson }) => {
      // They can see the meeting, and the id is right: neither makes the host's task theirs.
      await expect(readJson(`task://${ofHost.id}`)).rejects.toMatchObject({ code: FORBIDDEN });
      await expect(readJson(`task://${ofNobody.id}`)).resolves.toMatchObject({
        json: { task: { id: ofNobody.id } },
      });
    });

    await withMcpClient(suite, meeting.id, host, async ({ readJson }) => {
      await expect(readJson(`task://${ofHost.id}`)).resolves.toMatchObject({
        json: { task: { id: ofHost.id, title: TASK_TITLE } },
      });
    });
  });

  it('shows every member the tasks nobody owns, and lets none of them change one', async () => {
    const { participant, meeting } = await members();
    // As a digest's generation writes one: the meeting's, and no user's.
    const ofNobody = await tasks().upsert({ title: TASK_TITLE, sourceMeetingId: meeting.id });
    // Readable, and marked as not the reader's own: somebody else's words became it.
    const theMeetings = {
      tasks: [{ id: ofNobody.id, title: TASK_TITLE, status: 'OPEN', mine: false }],
    };

    await withMcpClient(suite, meeting.id, participant, async ({ callTool, readJson }) => {
      const found = await callTool('find_tasks', { query: 'launch emails' });

      expect(answerOf(found)).toMatchObject(theMeetings);
      await expect(readJson(OPEN_TASKS)).resolves.toMatchObject({ json: theMeetings });

      // The same title is a task of the member's own beside it, not a write to that one.
      await callTool('upsert_task', { title: TASK_TITLE, status: 'DONE' });
    });

    await expect(tasks().get(ofNobody.id)).resolves.toMatchObject({ status: 'OPEN' });
  });

  it('refuses a task past the most one member may have, in words that say so', async () => {
    const { host, meeting } = await members();
    await suite.prisma().$executeRaw`
      INSERT INTO "tasks" (id, title, source_meeting_id, owner_id, updated_at)
      SELECT gen_random_uuid(), 'Task ' || n, ${meeting.id}::uuid, ${host.id}::uuid, now()
      FROM generate_series(1, ${MAX_TASKS_PER_OWNER}) AS n
    `;

    await withMcpClient(suite, meeting.id, host, async ({ callTool }) => {
      const refused = await callTool('upsert_task', { title: 'One too many' });

      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toContain(`${MAX_TASKS_PER_OWNER} tasks`);
      // A task they already have is still theirs to finish.
      expect(
        answerOf(await callTool('upsert_task', { title: 'Task 1', status: 'DONE' })),
      ).toMatchObject({ task: { status: 'DONE' } });
    });
  });
});
