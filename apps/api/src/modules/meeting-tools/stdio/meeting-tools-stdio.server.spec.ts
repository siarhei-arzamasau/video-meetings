import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Logger } from '@nestjs/common';

import type { TaskService } from '../../tasks/services/task.service';
import { MAX_TASK_TITLE_LENGTH } from '../../tasks/task.constants';
import { FIND_TASKS_TOOL } from '../find-tasks.tool';
import { MEETING_ID, OTHER_MEETING_ID, TASK, TASK_AS_ANSWERED } from '../meeting-tools.fixture';
import { MEETING_TOOLS_STDIO_VERSION, MeetingToolsStdioServer } from './meeting-tools-stdio.server';

interface ToolAnswer {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/**
 * The server as a client meets it: a real MCP client and the real `McpServer`, joined in
 * memory instead of over a pipe. What a subprocess adds — stdout kept for the protocol, the
 * meeting on the command line, ending with its client — is `test/meeting-tools-stdio.e2e-spec.ts`'s.
 */
describe('MeetingToolsStdioServer', () => {
  const search = jest.fn();
  let client: Client;

  const call = async (input: object): Promise<ToolAnswer> =>
    (await client.callTool({ name: 'find_tasks', arguments: { ...input } })) as ToolAnswer;

  beforeEach(async () => {
    search.mockReset().mockResolvedValue([TASK]);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const tasks = { search } as unknown as TaskService;
    const server = new MeetingToolsStdioServer(tasks).create(MEETING_ID);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'spec', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });

  afterEach(async () => {
    await client.close();
    jest.restoreAllMocks();
  });

  it('says what it is, and that tools are what it serves', () => {
    expect(client.getServerVersion()).toMatchObject({
      name: 'meeting',
      version: MEETING_TOOLS_STDIO_VERSION,
    });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
  });

  it('offers find_tasks and no other tool, described as the in-process server describes it', async () => {
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'find_tasks',
      description: FIND_TASKS_TOOL.description,
      annotations: { readOnlyHint: true },
      // The Zod shape, as the JSON Schema a client is shown: one text, required and bounded.
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string', maxLength: MAX_TASK_TITLE_LENGTH } },
      },
    });
  });

  it('searches the one meeting it was made for, and answers with the tasks it found', async () => {
    const answer = await call({ query: '  launch emails ' });

    expect(search).toHaveBeenCalledWith('launch emails', MEETING_ID);
    expect(answer.isError ?? false).toBe(false);
    expect(JSON.parse(answer.content[0]?.text ?? 'null')).toEqual({ tasks: [TASK_AS_ANSWERED] });
  });

  it('has no meeting among its arguments for a caller to aim it at another', async () => {
    await call({ query: 'launch', meetingId: OTHER_MEETING_ID, sourceMeetingId: OTHER_MEETING_ID });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('launch', MEETING_ID);
  });

  it.each([
    ['no query', {}],
    ['a blank query', { query: '   ' }],
    ['a query past the bound', { query: 'a'.repeat(MAX_TASK_TITLE_LENGTH + 1) }],
    ['a query that is not text', { query: 7 }],
  ])('refuses %s, and searches nothing', async (_case, input) => {
    const answer = await call(input);

    expect(answer.isError).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });

  it('answers a failed search as an error of its own wording, and logs the cause', async () => {
    search.mockRejectedValue(new Error('relation "tasks" does not exist'));

    await expect(call({ query: 'launch' })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'The tasks could not be searched.' }],
    });
    expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
  });
});
