import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { McpAdmission } from '../../mcp-registry/mcp-scope';
import { McpToolRegistry } from '../../mcp-registry/mcp-tool-registry';
import { TaskService } from '../services/task.service';
import { TaskTools } from './task-tools';

export const MEETING_ID = '44444444-4444-4444-8444-444444444444';
export const OTHER_MEETING_ID = '77777777-7777-4777-8777-777777777777';
export const REQUESTER = { userId: '11111111-1111-4111-8111-111111111111' };
export const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

export const TASK = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Rewrite the launch emails',
  sourceMeetingId: MEETING_ID,
  // The requester's own: what these answer with is theirs, or nobody's.
  ownerId: REQUESTER.userId as string | null,
  status: 'OPEN' as const,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  updatedAt: new Date('2026-10-01T10:00:00.000Z'),
};
export const TASK_AS_ANSWERED = {
  id: TASK.id,
  title: TASK.title,
  status: TASK.status,
  sourceMeetingId: MEETING_ID,
};

/** The sentence a gate of the specs' own refuses with. */
export const REFUSAL = 'Not for you.';

export interface ToolAnswer {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/** What a tool answered with, read back from the one text it sends. */
export const answerOf = (answer: ToolAnswer): unknown =>
  JSON.parse(answer.content[0]?.text ?? 'null');

/**
 * What the tasks domain offers, as a client meets it: `TaskTools` as Nest hands it out —
 * the task service injected, the registrar added to the registry as its module starts — on
 * a server of the specs' own, joined in memory to a real MCP client.
 */
export interface TaskToolsHarness {
  client: Client;
  registry: McpToolRegistry;
  search: jest.Mock;
  upsert: jest.Mock;
  open: jest.Mock;
  get: jest.Mock;
  /** The scope's gate: lets `REQUESTER` in until a spec says otherwise. */
  admit: jest.Mock<Promise<McpAdmission>, []>;
  callTool(name: string, input: object): Promise<ToolAnswer>;
  /** The JSON one resource was read as, with the address and type it was answered under. */
  readJson(uri: string): Promise<{ uri: string; mimeType?: string; json: unknown }>;
}

export async function connectTaskTools(): Promise<TaskToolsHarness> {
  const search = jest.fn().mockResolvedValue([TASK]);
  const upsert = jest.fn().mockResolvedValue(TASK);
  const open = jest.fn().mockResolvedValue([TASK]);
  const get = jest.fn().mockResolvedValue(TASK);
  const admit = jest.fn<Promise<McpAdmission>, []>().mockResolvedValue({ requester: REQUESTER });

  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  const moduleRef = await Test.createTestingModule({
    providers: [
      TaskTools,
      McpToolRegistry,
      { provide: TaskService, useValue: { search, upsert, open, get } },
    ],
  }).compile();
  // Starting the module is what puts the registrar in the registry: nothing below names
  // `TaskTools`, as no server does.
  await moduleRef.init();

  const registry = moduleRef.get(McpToolRegistry);
  const server = new McpServer({ name: 'spec', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spec', version: '0.0.0' });

  registry.registerAll(server, { meetingId: MEETING_ID, admit });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return {
    client,
    registry,
    search,
    upsert,
    open,
    get,
    admit,
    callTool: async (name, input) =>
      (await client.callTool({ name, arguments: { ...input } })) as ToolAnswer,
    readJson: async (uri) => {
      const { contents } = await client.readResource({ uri });
      const [content] = contents as Array<{ uri: string; mimeType?: string; text: string }>;

      return {
        uri: content?.uri ?? '',
        mimeType: content?.mimeType,
        json: JSON.parse(content?.text ?? 'null'),
      };
    },
  };
}
