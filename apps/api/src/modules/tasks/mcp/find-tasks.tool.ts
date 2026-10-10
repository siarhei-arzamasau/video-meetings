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
 * **One name and one shape for two servers** — the one a digest's run is handed in this
 * process, and the MCP server a client reaches at `/api/mcp`. What is searched differs: a
 * digest's run answers no user and searches the tasks nobody owns, which are the ones such
 * runs write; an MCP client is a user and searches their own, which is why that server
 * says so in a description of its own (`OWN_TASKS_DESCRIPTION`).
 */
export const FIND_TASKS_TOOL = {
  name: TaskToolName.FIND_TASKS,
  description:
    'Finds the tasks this meeting already has whose title is similar to the text, the most similar first. Use it before creating a task, to see whether it already exists.',
  inputSchema: FIND_TASKS_INPUT,
  annotations: { readOnlyHint: true },
} as const;

/** `find_tasks` as the server that answers a user describes it: their tasks, nobody else's. */
export const OWN_TASKS_DESCRIPTION =
  'Finds your tasks of this meeting whose title is similar to the text, the most similar first. Use it before creating a task, to see whether you already have it.';

/**
 * Which tasks a search is of: one meeting's, and of those one owner's. **Said every time,
 * with no default**: a search that forgot whose tasks it was after would be of everybody's.
 */
export interface TasksSearched {
  meetingId: string;
  /** The user the server answers; `null` for a digest's run, which answers none. */
  ownerId: string | null;
}

/**
 * What `find_tasks` does, for the one meeting its server was made for and the one user it
 * answers: both are the server's, never an argument, so nothing a model sends can widen the
 * search to another meeting or to somebody else's tasks.
 *
 * **It never throws.** A failed search is logged through the caller's logger and answered as
 * an error in a sentence of this file's own: what a thrown error says — a relation's name, a
 * statement — would otherwise be the SDK's to hand to the model.
 */
export async function findTasksOf(
  tasks: TaskService,
  logger: Logger,
  { meetingId, ownerId }: TasksSearched,
  { query }: FindTasksInput,
): Promise<ToolResult> {
  try {
    return answered({ tasks: (await tasks.search(query, meetingId, ownerId)).map(taskOf) });
  } catch (error) {
    logger.error(`Tool ${FIND_TASKS_TOOL.name} failed`, describeError(error));

    return refused('The tasks could not be searched.');
  }
}
