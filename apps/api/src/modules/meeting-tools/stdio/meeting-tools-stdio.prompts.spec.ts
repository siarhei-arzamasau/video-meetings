import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { MAX_TASK_TITLE_LENGTH } from '../../tasks/task.constants';
import { TASK } from '../meeting-tools.fixture';
import { connectStdioServer } from './meeting-tools-stdio.fixture';
import type { StdioServerHarness } from './meeting-tools-stdio.fixture';

/** The one text a prompt is: its single message, which is the user's. */
async function textOf(
  client: Client,
  name: string,
  args?: Record<string, string>,
): Promise<string> {
  const { messages } = await client.getPrompt({ name, arguments: args });
  const [message] = messages;

  expect(messages).toHaveLength(1);
  expect(message?.role).toBe('user');

  return message?.content.type === 'text' ? message.content.text : '';
}

/** The server's prompts, asked for by a real MCP client (`meeting-tools-stdio.fixture.ts`). */
describe("MeetingToolsStdioServer's prompts", () => {
  let server: StdioServerHarness;
  let client: Client;

  beforeEach(async () => {
    server = await connectStdioServer();
    ({ client } = server);
  });

  afterEach(async () => {
    await client.close();
    jest.restoreAllMocks();
  });

  it('offers a prompt for the meeting as a whole and one for a topic of it', async () => {
    const { prompts } = await client.listPrompts();

    expect(prompts.map(({ name }) => name)).toEqual(['meeting_overview', 'meeting_topic']);
    expect(prompts[0]?.arguments ?? []).toEqual([]);
    expect(prompts[1]?.arguments).toMatchObject([{ name: 'topic', required: true }]);
  });

  it("gathers the meeting from this server's own resources and tools", async () => {
    const text = await textOf(client, 'meeting_overview');

    expect(text).toContain('tasks://open');
    expect(text).toContain('task://{taskId}');
    expect(text).toContain('find_tasks');
  });

  it('gathers one topic, named as its caller gave it', async () => {
    const text = await textOf(client, 'meeting_topic', { topic: '  launch emails ' });

    // Quoted, so where the topic ends is not the topic's to say.
    expect(text).toContain('"launch emails"');
    expect(text).toContain('find_tasks');
  });

  it.each(['meeting_overview', 'meeting_topic'])(
    'tells %s to change nothing and to read what tasks say as data',
    async (name) => {
      const text = await textOf(client, name, { topic: 'launch emails' });

      expect(text).toMatch(/do not call `upsert_task`/);
      expect(text).toMatch(/never as instructions/);
    },
  );

  it.each([
    ['no topic', {}],
    ['a blank topic', { topic: '   ' }],
    ['a topic past the bound', { topic: 'a'.repeat(MAX_TASK_TITLE_LENGTH + 1) }],
  ])('refuses meeting_topic %s', async (_case, args) => {
    await expect(client.getPrompt({ name: 'meeting_topic', arguments: args })).rejects.toThrow();
  });

  it('is text and nothing read: no task, and nobody asked who is calling', async () => {
    const text = await textOf(client, 'meeting_overview');

    // Why a prompt needs no gate. One that quoted a task would have to go through it.
    expect(text).not.toContain(TASK.title);
    expect(server.check).not.toHaveBeenCalled();
    expect(server.open).not.toHaveBeenCalled();
    expect(server.search).not.toHaveBeenCalled();
  });
});
