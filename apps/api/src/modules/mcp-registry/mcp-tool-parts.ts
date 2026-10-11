import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * What every tool is made of, whichever domain registers it and whichever server hands it
 * out: the bound of a text it takes, and the shape of what it answers with.
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
