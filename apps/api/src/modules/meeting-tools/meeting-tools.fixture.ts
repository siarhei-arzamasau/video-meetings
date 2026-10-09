import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { z } from 'zod';

import type {
  ClaudeAgentToolkit,
  ClaudeAgentToolkitLoader,
} from '../claude-agent/services/claude-agent-toolkit.loader';
import { MeetingDigestRevisionOutcome } from '../meeting-digests/commands/revise-meeting-digest.command';
import { TaskService } from '../tasks/services/task.service';
import { MeetingToolName, MeetingTools } from './meeting-tools';

export const MEETING_ID = '44444444-4444-4444-8444-444444444444';
export const LETTERED_MEETING_ID = 'abcdef12-4444-4444-8444-444444444444';
export const OTHER_MEETING_ID = '77777777-7777-4777-8777-777777777777';

export const TASK = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Rewrite the launch emails',
  sourceMeetingId: MEETING_ID,
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

export interface DescribedTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (input: unknown, extra: unknown) => Promise<ToolAnswer>;
  annotations?: { readOnlyHint?: boolean };
}

export interface ToolAnswer {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

export interface DescribedServer {
  name: string;
  tools: DescribedTool[];
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
export const answerOf = ({ content }: ToolAnswer): unknown =>
  JSON.parse(content[0]?.text ?? 'null');

export interface MeetingToolsSuite {
  search: jest.Mock;
  upsert: jest.Mock;
  execute: jest.Mock;
  tools: MeetingTools;
  /** The server made for `MEETING_ID`, as the fake toolkit describes it. */
  server(): Promise<DescribedServer>;
  toolNamed(name: MeetingToolName): Promise<DescribedTool>;
  /** Calls a tool as the SDK does: the input through its schema first, then the handler. */
  call(name: MeetingToolName, input: object): Promise<ToolAnswer>;
  /** Whether a tool's schema takes the input at all. */
  accepts(name: MeetingToolName, input: object): Promise<boolean>;
}

/**
 * What every spec of the tools sets up: `MeetingTools` over the fake toolkit and mocks of
 * what is behind each tool, answering as a search that found `TASK`, a write that stored
 * it, and a revision that went through. Call it at describe scope.
 */
export function useMeetingTools(): MeetingToolsSuite {
  const search = jest.fn();
  const upsert = jest.fn();
  const execute = jest.fn();
  const tools = new MeetingTools(
    { loadToolkit: () => Promise.resolve(toolkit) } as ClaudeAgentToolkitLoader,
    { search, upsert } as unknown as TaskService,
    { execute } as unknown as CommandBus,
  );

  const server = async (): Promise<DescribedServer> =>
    (await tools.createServer(MEETING_ID)) as unknown as DescribedServer;
  const toolNamed = async (name: MeetingToolName): Promise<DescribedTool> => {
    const described = (await server()).tools.find((tool) => tool.name === name);

    if (described === undefined) {
      throw new Error(`No tool is named ${name}`);
    }

    return described;
  };

  beforeEach(() => {
    search.mockReset().mockResolvedValue([TASK]);
    upsert.mockReset().mockResolvedValue(TASK);
    execute.mockReset().mockResolvedValue(MeetingDigestRevisionOutcome.REVISED);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  return {
    search,
    upsert,
    execute,
    tools,
    server,
    toolNamed,
    call: async (name, input) => {
      const tool = await toolNamed(name);

      return tool.handler(z.object(tool.inputSchema).parse(input), undefined);
    },
    accepts: async (name, input) =>
      z.object((await toolNamed(name)).inputSchema).safeParse(input).success,
  };
}
