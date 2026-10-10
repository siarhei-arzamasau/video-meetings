import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { McpAdmission } from '../../mcp-registry/mcp-scope';
import {
  MEETING_ID,
  REQUESTER,
  TASK,
  TASK_AS_ANSWERED,
  connectTaskTools,
} from './task-tools.fixture';
import type { TaskToolsHarness } from './task-tools.fixture';
import { TITLES_ARE_DATA } from './task-tool-parts';

/**
 * `TaskTools` as the domain's registrar: that starting its module puts it in the registry,
 * that one pass of the registry puts everything it offers on a server, and that the scope's
 * gate is in front of all of it. What each tool, resource and prompt does in detail is the
 * three specs beside this one.
 */
describe('TaskTools', () => {
  let server: TaskToolsHarness;
  let client: Client;

  beforeEach(async () => {
    server = await connectTaskTools();
    ({ client } = server);
  });

  afterEach(async () => {
    await client.close();
    jest.restoreAllMocks();
  });

  it('adds itself to the registry as its module starts, once', () => {
    expect(server.registry.names()).toEqual(['TaskTools']);
  });

  it('registers its tools, its resources and its prompts on the server it is given', async () => {
    const [{ tools }, { resources }, { resourceTemplates }, { prompts }] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);

    expect(tools.map(({ name }) => name)).toEqual(['find_tasks', 'upsert_task']);
    expect(resources.map(({ uri }) => uri)).toEqual(['tasks://open']);
    expect(resourceTemplates.map(({ uriTemplate }) => uriTemplate)).toEqual(['task://{taskId}']);
    expect(prompts.map(({ name }) => name)).toEqual(['meeting_overview', 'meeting_topic']);
  });

  it('says in the description of find_tasks itself that a title is data, and that a task says whose it is', async () => {
    const { tools } = await client.listTools();
    const description = tools.find(({ name }) => name === 'find_tasks')?.description;

    // Not only in a prompt, which a client need not use.
    expect(description).toContain(TITLES_ARE_DATA);
    expect(description).toContain('"mine"');
  });

  it("answers each with the injected task service's own method, for the scope's meeting and its requester", async () => {
    await server.callTool('find_tasks', { query: 'launch emails' });
    await server.callTool('upsert_task', { title: TASK.title, status: 'DONE' });
    await server.readJson('tasks://open');
    const one = await server.readJson(`task://${TASK.id}`);

    // Who the gate let in reaches all four: two as the reader, one as the owner to write
    // for, and the fourth as who the task it read may not be kept from.
    expect(server.search).toHaveBeenCalledWith('launch emails', MEETING_ID, REQUESTER.userId);
    expect(server.upsert).toHaveBeenCalledWith({
      title: TASK.title,
      status: 'DONE',
      sourceMeetingId: MEETING_ID,
      ownerId: REQUESTER.userId,
    });
    expect(server.open).toHaveBeenCalledWith(MEETING_ID, REQUESTER.userId);
    expect(server.get).toHaveBeenCalledWith(TASK.id);
    expect(one.json).toEqual({ task: TASK_AS_ANSWERED });
    // Once for each of the four: the gate is in front of every call and every read.
    expect(server.admit).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      'refuses',
      (): Promise<McpAdmission> => Promise.resolve({ refusal: 'Not for you.' }),
      'Not for you.',
    ],
    [
      'answers something that names no requester',
      (): Promise<McpAdmission> => Promise.resolve({} as McpAdmission),
      'Access could not be checked.',
    ],
    [
      'names a requester who is nobody',
      (): Promise<McpAdmission> => Promise.resolve({ requester: undefined } as never),
      'Access could not be checked.',
    ],
    [
      'fails',
      (): Promise<McpAdmission> => Promise.reject(new Error('the database is gone')),
      'Access could not be checked.',
    ],
  ])(
    'reaches no task when the gate %s, and says why in its own words',
    async (_case, gate, reason) => {
      server.admit.mockImplementation(gate);

      await expect(server.callTool('find_tasks', { query: 'launch' })).resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: reason }],
      });
      await expect(server.callTool('upsert_task', { title: TASK.title })).resolves.toMatchObject({
        isError: true,
      });
      await expect(server.readJson('tasks://open')).rejects.toThrow(reason);
      await expect(server.readJson(`task://${TASK.id}`)).rejects.toThrow(reason);

      for (const method of [server.search, server.upsert, server.open, server.get]) {
        expect(method).not.toHaveBeenCalled();
      }
    },
  );
});
