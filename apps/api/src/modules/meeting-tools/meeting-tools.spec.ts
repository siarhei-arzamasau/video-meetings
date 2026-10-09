import { Logger } from '@nestjs/common';

import { MAX_TASK_TITLE_LENGTH } from '../tasks/task.constants';
import { MEETING_TOOLS_SERVER_NAME, MeetingToolName } from './meeting-tools';
import {
  LETTERED_MEETING_ID,
  MEETING_ID,
  OTHER_MEETING_ID,
  TASK_AS_ANSWERED,
  answerOf,
  useMeetingTools,
} from './meeting-tools.fixture';
import type { DescribedTool } from './meeting-tools.fixture';

/** The server and its two task tools. `update_meeting` is `meeting-tools.update-meeting.spec.ts`. */
describe('MeetingTools', () => {
  const { search, upsert, tools, server, toolNamed, call, accepts } = useMeetingTools();

  it('registers the three tools on a server named meeting', async () => {
    const { name, tools: described } = await server();

    expect(name).toBe(MEETING_TOOLS_SERVER_NAME);
    expect(name).toBe('meeting');
    expect(described.map((tool) => tool.name)).toEqual([
      'find_tasks',
      'upsert_task',
      'update_meeting',
    ]);
  });

  it('marks find_tasks as read-only, and neither tool that writes', async () => {
    await expect(toolNamed(MeetingToolName.FIND_TASKS)).resolves.toMatchObject({
      annotations: { readOnlyHint: true },
    });

    const writers = await Promise.all(
      [MeetingToolName.UPSERT_TASK, MeetingToolName.UPDATE_MEETING].map(toolNamed),
    );

    expect(writers.map((tool) => tool.annotations?.readOnlyHint)).toEqual([undefined, undefined]);
  });

  describe('find_tasks', () => {
    it('searches through TaskService, and answers with the tasks it found', async () => {
      const answer = await call(MeetingToolName.FIND_TASKS, { query: '  launch emails ' });

      expect(search).toHaveBeenCalledWith('launch emails', MEETING_ID);
      expect(answer.isError).toBeUndefined();
      expect(answerOf(answer)).toEqual({ tasks: [TASK_AS_ANSWERED] });
    });

    it.each([
      ['no query', {}],
      ['a blank query', { query: '   ' }],
      ['a query past the bound', { query: 'a'.repeat(MAX_TASK_TITLE_LENGTH + 1) }],
      ['a query that is not text', { query: 7 }],
    ])('refuses %s', async (_case, input) => {
      await expect(accepts(MeetingToolName.FIND_TASKS, input)).resolves.toBe(false);
    });

    it('answers a failed search as an error of its own wording, and logs the cause', async () => {
      search.mockRejectedValue(new Error('relation "tasks" does not exist'));

      const answer = await call(MeetingToolName.FIND_TASKS, { query: 'launch' });

      expect(answer).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'The tasks could not be searched.' }],
      });
      expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('upsert_task', () => {
    it('upserts through TaskService, the title trimmed, and answers with the task', async () => {
      const answer = await call(MeetingToolName.UPSERT_TASK, {
        title: ' Rewrite the launch emails ',
        status: 'DONE',
        sourceMeetingId: MEETING_ID,
      });

      expect(upsert).toHaveBeenCalledWith({
        title: 'Rewrite the launch emails',
        status: 'DONE',
        sourceMeetingId: MEETING_ID,
      });
      expect(answerOf(answer)).toEqual({ task: TASK_AS_ANSWERED });
    });

    it('passes no status when none is given, so an existing task keeps its own', async () => {
      await call(MeetingToolName.UPSERT_TASK, { title: 'Call Bob', sourceMeetingId: MEETING_ID });

      expect(upsert).toHaveBeenCalledWith({
        title: 'Call Bob',
        status: undefined,
        sourceMeetingId: MEETING_ID,
      });
    });

    it.each([
      ['a blank title', { title: ' ', sourceMeetingId: MEETING_ID }],
      ['a title of one character', { title: 'x', sourceMeetingId: MEETING_ID }],
      ['a title of two characters among spaces', { title: '  QA  ', sourceMeetingId: MEETING_ID }],
      ['a title past the bound', { title: 'a'.repeat(501), sourceMeetingId: MEETING_ID }],
      [
        'a status that is not one',
        { title: 'Call Bob', status: 'open', sourceMeetingId: MEETING_ID },
      ],
      ['a meeting id that is not an id', { title: 'Call Bob', sourceMeetingId: 'the-meeting' }],
      ['no meeting id', { title: 'Call Bob' }],
    ])('refuses %s', async (_case, input) => {
      await expect(accepts(MeetingToolName.UPSERT_TASK, input)).resolves.toBe(false);
    });

    it('refuses a task of any meeting but the one the server was made for', async () => {
      const answer = await call(MeetingToolName.UPSERT_TASK, {
        title: 'Call Bob',
        sourceMeetingId: OTHER_MEETING_ID,
      });

      expect(answer.isError).toBe(true);
      expect(answer.content[0]?.text).toMatch(/one meeting/);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('takes the id of its own meeting in whatever case it is written', async () => {
      const lettered = (await tools.createServer(LETTERED_MEETING_ID)) as unknown as {
        tools: DescribedTool[];
      };
      const upsertTask = lettered.tools.find(({ name }) => name === MeetingToolName.UPSERT_TASK);

      await upsertTask?.handler(
        { title: 'Call Bob', sourceMeetingId: LETTERED_MEETING_ID.toUpperCase() },
        undefined,
      );

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMeetingId: LETTERED_MEETING_ID }),
      );
    });

    it('answers a failed write as an error that quotes nothing of the cause', async () => {
      upsert.mockRejectedValue(new Error('violates "tasks_source_meeting_id_fkey"'));

      const answer = await call(MeetingToolName.UPSERT_TASK, {
        title: 'Call Bob',
        sourceMeetingId: MEETING_ID,
      });

      expect(answer.isError).toBe(true);
      expect(answer.content[0]?.text).toBe('The task could not be saved. Check the meeting id.');
    });
  });
});
