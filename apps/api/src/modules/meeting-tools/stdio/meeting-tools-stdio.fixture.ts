import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Logger } from '@nestjs/common';

import type { TaskService } from '../../tasks/services/task.service';
import { MEETING_ID, TASK } from '../meeting-tools.fixture';
import { MeetingToolsStdioAccessOutcome } from './meeting-tools-stdio.access';
import type {
  MeetingToolsStdioAccess,
  MeetingToolsStdioAdmission,
  MeetingToolsStdioRefusal,
} from './meeting-tools-stdio.access';
import { MeetingToolsStdioServer } from './meeting-tools-stdio.server';

export const ACCESS_TOKEN = 'header.payload.signature';
export const REQUESTER = { userId: '11111111-1111-4111-8111-111111111111' };

export const GRANTED: MeetingToolsStdioAdmission = {
  outcome: MeetingToolsStdioAccessOutcome.GRANTED,
  requester: REQUESTER,
};

export const refusedAs = (outcome: MeetingToolsStdioRefusal): MeetingToolsStdioAdmission => ({
  outcome,
});

export interface ToolAnswer {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/** What a tool answered with, read back from the one text it sends. */
export const answerOf = (answer: ToolAnswer): unknown =>
  JSON.parse(answer.content[0]?.text ?? 'null');

/**
 * The server as a client meets it: a real MCP client and the real `McpServer`, joined in
 * memory instead of over a pipe, over a `TaskService` and an access check that are mocks.
 */
export interface StdioServerHarness {
  client: Client;
  search: jest.Mock;
  upsert: jest.Mock;
  open: jest.Mock;
  get: jest.Mock;
  check: jest.Mock;
  callTool(name: string, input: object): Promise<ToolAnswer>;
  /** The JSON one resource was read as, with the address and type it was answered under. */
  readJson(uri: string): Promise<{ uri: string; mimeType?: string; json: unknown }>;
}

/**
 * A server for `MEETING_ID`, connected: a user who is let in, one task behind every read,
 * and the server's errors and warnings kept out of the run's output.
 */
export async function connectStdioServer(): Promise<StdioServerHarness> {
  const search = jest.fn().mockResolvedValue([TASK]);
  const upsert = jest.fn().mockResolvedValue(TASK);
  const open = jest.fn().mockResolvedValue([TASK]);
  const get = jest.fn().mockResolvedValue(TASK);
  const check = jest.fn().mockResolvedValue(GRANTED);

  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  const tasks = { search, upsert, open, get } as unknown as TaskService;
  const access = { check } as unknown as MeetingToolsStdioAccess;
  const server = new MeetingToolsStdioServer(tasks, access).create(MEETING_ID, ACCESS_TOKEN);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spec', version: '0.0.0' });

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return {
    client,
    search,
    upsert,
    open,
    get,
    check,
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
