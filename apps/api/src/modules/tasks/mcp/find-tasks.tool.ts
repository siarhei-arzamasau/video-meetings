import type { Logger } from '@nestjs/common';
import type { z } from 'zod';

import { describeError } from '../../../common/error-message';
import type { TaskService } from '../services/task.service';
import { MAX_TASK_TITLE_LENGTH } from '../task.constants';
import { answered, refused, textUpTo } from '../../mcp-registry/mcp-tool-parts';
import type { ToolResult } from '../../mcp-registry/mcp-tool-parts';
import { TaskToolName, taskOf } from './task-tool-parts';

const FIND_TASKS_INPUT = {
  query: textUpTo(MAX_TASK_TITLE_LENGTH).describe('What the task is about, or its title.'),
};

export type FindTasksInput = z.infer<z.ZodObject<typeof FIND_TASKS_INPUT>>;

/**
 * `find_tasks` as every server that offers it describes it: its name, what it tells a model
 * it is for, the Zod shape its input is held to, and that it only reads.
 *
 * **One description for two servers** — the one a digest's run is handed in this process,
 * and the MCP server a client reaches at `/api/mcp` — so the tool a model meets is the same
 * tool whichever way it is reached, and a change to it is made once.
 */
export const FIND_TASKS_TOOL = {
  name: TaskToolName.FIND_TASKS,
  description:
    'Finds the tasks this meeting already has whose title is similar to the text, the most similar first. Use it before creating a task, to see whether it already exists.',
  inputSchema: FIND_TASKS_INPUT,
  annotations: { readOnlyHint: true },
} as const;

/**
 * What `find_tasks` does, for the one meeting its server was made for: the meeting is the
 * server's, never an argument, so nothing a model sends can widen the search to another.
 *
 * **It never throws.** A failed search is logged through the caller's logger and answered as
 * an error in a sentence of this file's own: what a thrown error says — a relation's name, a
 * statement — would otherwise be the SDK's to hand to the model.
 */
export async function findTasksOf(
  tasks: TaskService,
  logger: Logger,
  meetingId: string,
  { query }: FindTasksInput,
): Promise<ToolResult> {
  try {
    return answered({ tasks: (await tasks.search(query, meetingId)).map(taskOf) });
  } catch (error) {
    logger.error(`Tool ${FIND_TASKS_TOOL.name} failed`, describeError(error));

    return refused('The tasks could not be searched.');
  }
}
