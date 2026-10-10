import { TaskService } from '../src/modules/tasks/services/task.service';
import { useApiSuite } from './utils/api-suite';
import { EMAIL, OTHER_EMAIL } from './utils/fixtures';
import { answerOf, withMcpClient } from './utils/mcp-client';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const TASK_TITLE = 'Rewrite the launch emails';
const OPEN_TASKS = 'tasks://open';
const FORBIDDEN = 403;

/**
 * Whose tasks the MCP server answers with: two members of one meeting, each with a client
 * of their own, and each reading and writing their own tasks and nobody else's. An id or an
 * owner among a request's arguments says what to look for — never who may see it.
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
      const mine = { tasks: [{ title: TASK_TITLE, status: 'OPEN', sourceMeetingId: meeting.id }] };

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

  it("refuses a read of another member's task by its id as forbidden, and of nobody's", async () => {
    const { host, participant, meeting } = await members();
    const sourceMeetingId = meeting.id;
    const ofHost = await tasks().upsert({ title: TASK_TITLE, sourceMeetingId, ownerId: host.id });
    // A task nobody owns, as a digest's generation writes one.
    const ofNobody = await tasks().upsert({ title: 'Book the venue', sourceMeetingId });

    await withMcpClient(suite, meeting.id, participant, async ({ readJson }) => {
      // Both can see the meeting, and the id is right: neither makes the task theirs.
      await expect(readJson(`task://${ofHost.id}`)).rejects.toMatchObject({ code: FORBIDDEN });
      await expect(readJson(`task://${ofNobody.id}`)).rejects.toMatchObject({ code: FORBIDDEN });
    });

    await withMcpClient(suite, meeting.id, host, async ({ readJson }) => {
      await expect(readJson(`task://${ofHost.id}`)).resolves.toMatchObject({
        json: { task: { id: ofHost.id, title: TASK_TITLE } },
      });
      await expect(readJson(`task://${ofNobody.id}`)).rejects.toMatchObject({ code: FORBIDDEN });
    });
  });

  it('shows nobody the tasks nobody owns', async () => {
    const { host, meeting } = await members();
    await tasks().upsert({ title: TASK_TITLE, sourceMeetingId: meeting.id });

    await withMcpClient(suite, meeting.id, host, async ({ callTool, readJson }) => {
      expect(answerOf(await callTool('find_tasks', { query: 'launch emails' }))).toEqual({
        tasks: [],
      });
      await expect(readJson(OPEN_TASKS)).resolves.toMatchObject({ json: { tasks: [] } });
    });
  });
});
