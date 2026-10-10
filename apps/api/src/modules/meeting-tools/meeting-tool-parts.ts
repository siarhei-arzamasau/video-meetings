import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { TaskStatus } from '../../generated/prisma/enums';

/**
 * What every meeting tool is made of, whichever server hands it out: the bound of a text it
 * takes, and the shape of what it answers with.
 */

/** What a tool answers with: MCP's own result, as both SDKs that serve these tools take it. */
export type ToolResult = CallToolResult;

/** Text with something in it, trimmed, and no longer than `maxLength`. */
export const textUpTo = (maxLength: number, minLength = 1): z.ZodString =>
  z.string().trim().min(minLength).max(maxLength);

export const answered = (answer: object): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(answer) }],
});

export const refused = (reason: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: reason }],
});

/** A task as a tool answers with it: what identifies it and where it stands, no timestamps. */
export const taskOf = ({
  id,
  title,
  status,
  sourceMeetingId,
}: {
  id: string;
  title: string;
  status: TaskStatus;
  sourceMeetingId: string;
}): object => ({ id, title, status, sourceMeetingId });
