import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { z } from 'zod';

import type {
  ClaudeAgentToolkit,
  ClaudeAgentToolkitLoader,
} from '../claude-agent/services/claude-agent-toolkit.loader';
import {
  MeetingDigestRevisionOutcome,
  ReviseMeetingDigestCommand,
} from '../meeting-digests/commands/revise-meeting-digest.command';
import {
  MAX_DIGEST_ITEMS,
  MAX_DIGEST_SUMMARY_LENGTH,
} from '../meeting-digests/meeting-digest.constants';
import { TaskService } from '../tasks/services/task.service';
import { MAX_TASK_TITLE_LENGTH } from '../tasks/task.constants';
import { MEETING_TOOLS_SERVER_NAME, MeetingToolName, MeetingTools } from './meeting-tools';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const LETTERED_MEETING_ID = 'abcdef12-4444-4444-8444-444444444444';
const OTHER_MEETING_ID = '77777777-7777-4777-8777-777777777777';

const TASK = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Rewrite the launch emails',
  sourceMeetingId: MEETING_ID,
  status: 'OPEN' as const,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  updatedAt: new Date('2026-10-01T10:00:00.000Z'),
};
const TASK_AS_ANSWERED = {
  id: TASK.id,
  title: TASK.title,
  status: TASK.status,
  sourceMeetingId: MEETING_ID,
};

interface DescribedTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (input: unknown, extra: unknown) => Promise<ToolAnswer>;
  annotations?: { readOnlyHint?: boolean };
}

interface ToolAnswer {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/**
 * The SDK's two functions as they were observed to behave: `tool` answers with its
 * arguments under their names, and `createSdkMcpServer` registers what it is given. The
 * real ones are ESM, which this suite cannot load — and nothing here is about them: what is
 * held to account is what this file describes, and what each handler does.
 */
const toolkit = {
  tool: (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: DescribedTool['handler'],
    extras?: { annotations?: DescribedTool['annotations'] },
  ): DescribedTool => ({ name, description, inputSchema, handler, ...extras }),
  createSdkMcpServer: (options: object): object => ({ type: 'sdk', ...options }),
} as unknown as ClaudeAgentToolkit;

/** What a tool answered with, read back out of the text it is carried in. */
const answerOf = ({ content }: ToolAnswer): unknown => JSON.parse(content[0]?.text ?? 'null');

describe('MeetingTools', () => {
  const search = jest.fn();
  const upsert = jest.fn();
  const execute = jest.fn();
  const tools = new MeetingTools(
    { loadToolkit: () => Promise.resolve(toolkit) } as ClaudeAgentToolkitLoader,
    { search, upsert } as unknown as TaskService,
    { execute } as unknown as CommandBus,
  );

  const server = async (): Promise<{ name: string; tools: DescribedTool[] }> =>
    (await tools.createServer(MEETING_ID)) as unknown as { name: string; tools: DescribedTool[] };
  const toolNamed = async (name: MeetingToolName): Promise<DescribedTool> => {
    const described = (await server()).tools.find((tool) => tool.name === name);

    if (described === undefined) {
      throw new Error(`No tool is named ${name}`);
    }

    return described;
  };
  /** Calls a tool as the SDK does: the input through its schema first, then the handler. */
  const call = async (name: MeetingToolName, input: object): Promise<ToolAnswer> => {
    const tool = await toolNamed(name);

    return tool.handler(z.object(tool.inputSchema).parse(input), undefined);
  };
  const accepts = async (name: MeetingToolName, input: object): Promise<boolean> =>
    z.object((await toolNamed(name)).inputSchema).safeParse(input).success;

  beforeEach(() => {
    search.mockReset().mockResolvedValue([TASK]);
    upsert.mockReset().mockResolvedValue(TASK);
    execute.mockReset().mockResolvedValue(MeetingDigestRevisionOutcome.REVISED);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  describe('update_meeting', () => {
    const input = {
      meetingId: MEETING_ID,
      summary: ' The launch moves to May. ',
      decisions: ['Launch in May.', ' Hire two. '],
    };

    it('dispatches the revision of the digest, every text trimmed', async () => {
      const answer = await call(MeetingToolName.UPDATE_MEETING, input);

      expect(execute).toHaveBeenCalledWith(
        new ReviseMeetingDigestCommand(MEETING_ID, 'The launch moves to May.', [
          'Launch in May.',
          'Hire two.',
        ]),
      );
      expect(execute.mock.calls[0]?.[0]).toBeInstanceOf(ReviseMeetingDigestCommand);
      expect(answerOf(answer)).toEqual({ meetingId: MEETING_ID, updated: true });
    });

    it('refuses any meeting but the one the server was made for, and dispatches nothing', async () => {
      const answer = await call(MeetingToolName.UPDATE_MEETING, {
        ...input,
        meetingId: OTHER_MEETING_ID,
      });

      expect(answer.isError).toBe(true);
      expect(answer.content[0]?.text).toMatch(/one meeting/);
      expect(execute).not.toHaveBeenCalled();
    });

    it.each([
      [MeetingDigestRevisionOutcome.NO_DIGEST, /no digest yet/],
      [MeetingDigestRevisionOutcome.UNFIT, /blank or too long/],
    ])('answers %s as an error that says why', async (outcome, reason) => {
      execute.mockResolvedValue(outcome);

      const answer = await call(MeetingToolName.UPDATE_MEETING, input);

      expect(answer.isError).toBe(true);
      expect(answer.content[0]?.text).toMatch(reason);
    });

    it.each([
      ['a blank summary', { ...input, summary: '' }],
      [
        'a summary past the bound',
        { ...input, summary: 'a'.repeat(MAX_DIGEST_SUMMARY_LENGTH + 1) },
      ],
      ['a blank decision', { ...input, decisions: [' '] }],
      [
        'more decisions than a digest holds',
        { ...input, decisions: Array(MAX_DIGEST_ITEMS + 1).fill('One.') },
      ],
      ['decisions that are not a list', { ...input, decisions: 'Launch in May.' }],
      ['a meeting id that is not an id', { ...input, meetingId: '1' }],
    ])('refuses %s', async (_case, unfit) => {
      await expect(accepts(MeetingToolName.UPDATE_MEETING, unfit)).resolves.toBe(false);
    });

    it('accepts a meeting with no decisions', async () => {
      await expect(
        accepts(MeetingToolName.UPDATE_MEETING, { ...input, decisions: [] }),
      ).resolves.toBe(true);
    });

    it('answers a failed write as an error, and logs the cause', async () => {
      execute.mockRejectedValue(new Error('connection lost'));

      const answer = await call(MeetingToolName.UPDATE_MEETING, input);

      expect(answer).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'The meeting could not be updated.' }],
      });
      expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    });
  });
});
