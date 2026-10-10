import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Logger } from '@nestjs/common';

import { MAX_TASK_TITLE_LENGTH } from '../task.constants';
import { FIND_TASKS_TOOL } from './find-tasks.tool';
import {
  MEETING_ID,
  OTHER_MEETING_ID,
  REFUSAL,
  TASK_AS_ANSWERED,
  answerOf,
  connectTaskTools,
} from './task-tools.fixture';
import type { TaskToolsHarness } from './task-tools.fixture';
import { UPSERT_TASK_TOOL } from './upsert-task.tool';

/** The domain's two tools, called by a real MCP client (`task-tools.fixture.ts`). */
describe("TaskTools' tools", () => {
  let server: TaskToolsHarness;
  let client: Client;
  let search: jest.Mock;
  let upsert: jest.Mock;
  let admit: TaskToolsHarness['admit'];
  const call: TaskToolsHarness['callTool'] = (name, input) => server.callTool(name, input);

  beforeEach(async () => {
    server = await connectTaskTools();
    ({ client, search, upsert, admit } = server);
  });

  afterEach(async () => {
    await client.close();
    jest.restoreAllMocks();
  });

  it('offers find_tasks, which reads, and upsert_task, which does not — and no other tool', async () => {
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      name: 'find_tasks',
      // Described once, for this server and for a digest's run alike.
      description: FIND_TASKS_TOOL.description,
      annotations: { readOnlyHint: true },
      // The Zod shape, as the JSON Schema a client is shown: one text, required and bounded.
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string', maxLength: MAX_TASK_TITLE_LENGTH } },
      },
    });
    expect(tools[1]).toMatchObject({
      name: 'upsert_task',
      description: UPSERT_TASK_TOOL.description,
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', required: ['title'] },
    });
  });

  it('takes a title and a status for a task, and nothing that names a meeting', async () => {
    const { tools } = await client.listTools();
    const properties = tools[1]?.inputSchema.properties ?? {};

    // A task manager's tool: the meeting is the process's, and no argument can be one.
    expect(Object.keys(properties)).toEqual(['title', 'status']);
    expect(properties).toMatchObject({
      title: { type: 'string', maxLength: MAX_TASK_TITLE_LENGTH },
      status: { enum: ['OPEN', 'DONE'] },
    });
  });

  describe('find_tasks', () => {
    it('searches the one meeting it was made for, and answers with the tasks it found', async () => {
      const answer = await call('find_tasks', { query: '  launch emails ' });

      expect(search).toHaveBeenCalledWith('launch emails', MEETING_ID);
      expect(answer.isError ?? false).toBe(false);
      expect(answerOf(answer)).toEqual({ tasks: [TASK_AS_ANSWERED] });
    });

    it('has no meeting among its arguments for a caller to aim it at another', async () => {
      await call('find_tasks', {
        query: 'launch',
        meetingId: OTHER_MEETING_ID,
        sourceMeetingId: OTHER_MEETING_ID,
      });

      expect(search).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenCalledWith('launch', MEETING_ID);
    });

    it.each([
      ['no query', {}],
      ['a blank query', { query: '   ' }],
      ['a query past the bound', { query: 'a'.repeat(MAX_TASK_TITLE_LENGTH + 1) }],
      ['a query that is not text', { query: 7 }],
    ])('refuses %s, and searches nothing', async (_case, input) => {
      const answer = await call('find_tasks', input);

      expect(answer.isError).toBe(true);
      expect(search).not.toHaveBeenCalled();
    });

    it('answers a failed search as an error of its own wording, and logs the cause', async () => {
      search.mockRejectedValue(new Error('relation "tasks" does not exist'));

      await expect(call('find_tasks', { query: 'launch' })).resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'The tasks could not be searched.' }],
      });
      expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('upsert_task', () => {
    it('hands the task service the title, trimmed, the status, and the one meeting', async () => {
      const answer = await call('upsert_task', {
        title: '  Rewrite the launch emails ',
        status: 'DONE',
      });

      expect(upsert).toHaveBeenCalledWith({
        title: 'Rewrite the launch emails',
        status: 'DONE',
        sourceMeetingId: MEETING_ID,
      });
      expect(answer.isError ?? false).toBe(false);
      expect(answerOf(answer)).toEqual({ task: TASK_AS_ANSWERED });
    });

    it('passes no status when none is given, so an existing task keeps the one it has', async () => {
      await call('upsert_task', { title: 'Rewrite the launch emails' });

      expect(upsert).toHaveBeenCalledWith({
        title: 'Rewrite the launch emails',
        status: undefined,
        sourceMeetingId: MEETING_ID,
      });
    });

    it('writes to the one meeting it was made for, whatever a caller sends beside the task', async () => {
      await call('upsert_task', {
        title: 'Rewrite the launch emails',
        meetingId: OTHER_MEETING_ID,
        sourceMeetingId: OTHER_MEETING_ID,
      });

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ sourceMeetingId: MEETING_ID }));
    });

    it.each([
      ['no title', { status: 'OPEN' }],
      ['a title too short to be a task', { title: ' QA ' }],
      ['a title past the bound', { title: 'a'.repeat(MAX_TASK_TITLE_LENGTH + 1) }],
      ['a status a task cannot have', { title: 'Rewrite the launch emails', status: 'CANCELLED' }],
    ])('refuses %s, and writes nothing', async (_case, input) => {
      const answer = await call('upsert_task', input);

      expect(answer.isError).toBe(true);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('answers a failed write as an error of its own wording, and logs the cause', async () => {
      upsert.mockRejectedValue(
        new Error('violates foreign key constraint "tasks_source_meeting_id_fkey"'),
      );

      await expect(
        call('upsert_task', { title: 'Rewrite the launch emails' }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'The task could not be saved.' }],
      });
      expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    });
  });

  describe.each([
    ['find_tasks', { query: 'launch' }],
    ['upsert_task', { title: 'Rewrite the launch emails' }],
  ])("%s, behind the scope's gate", (tool, input) => {
    it('asks the gate before every call, not once', async () => {
      await call(tool, input);
      await call(tool, input);

      // A server may outlive what let its user in: the first answer says nothing of the second.
      expect(admit).toHaveBeenCalledTimes(2);
    });

    it("answers a refusal as an error in the gate's own words, and reaches no task", async () => {
      admit.mockResolvedValue({ refusal: REFUSAL });

      const answer = await call(tool, input);

      expect(answer.isError).toBe(true);
      expect(answer.content[0]?.text).toBe(REFUSAL);
      expect(search).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });

    it('stays closed when the gate itself fails, and logs the cause', async () => {
      admit.mockRejectedValue(new Error('relation "meetings" does not exist'));

      // Failing open here would hand the tasks to a user nobody managed to check.
      await expect(call(tool, input)).resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Access could not be checked.' }],
      });
      expect(search).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    });
  });
});
