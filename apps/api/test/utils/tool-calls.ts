import { z } from 'zod';

import { ClaudeAgentToolkitLoader } from '../../src/modules/claude-agent/services/claude-agent-toolkit.loader';

export interface DescribedTool {
  name: string;
  inputSchema: z.ZodRawShape;
  handler: (input: unknown, extra: unknown) => Promise<ToolAnswer>;
}

export interface ToolAnswer {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/**
 * The SDK's `tool` and `createSdkMcpServer` as they behave, without the SDK: it is ESM, and
 * this suite cannot load it. What stays real is everything behind a tool — the provider as
 * `AppModule` wires it, `TaskService`, the command bus, the digest's handler, the database.
 */
const TOOLKIT = {
  tool: (name: string, _description: string, inputSchema: object, handler: unknown): object => ({
    name,
    inputSchema,
    handler,
  }),
  createSdkMcpServer: (options: object): object => options,
};

/** What `createTestApp` needs to stand the toolkit above in the SDK's place. */
export const TOOLKIT_OVERRIDE = {
  token: ClaudeAgentToolkitLoader,
  value: { loadToolkit: () => Promise.resolve(TOOLKIT) },
};

/**
 * Calls a tool of a server made over the toolkit above, as the SDK does: the input through
 * its schema first, then the handler.
 */
export async function callTool(server: unknown, name: string, input: object): Promise<ToolAnswer> {
  const tool = (server as { tools: DescribedTool[] }).tools.find(
    (described) => described.name === name,
  );

  if (tool === undefined) {
    throw new Error(`No tool is named ${name}`);
  }

  return tool.handler(z.object(tool.inputSchema).parse(input), undefined);
}

/** What a tool answered with, read back out of the text it is carried in. */
export const answerOf = ({ content }: ToolAnswer): Record<string, unknown> =>
  JSON.parse(content[0]?.text ?? 'null') as Record<string, unknown>;
