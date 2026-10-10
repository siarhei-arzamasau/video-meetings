import type { Logger } from '@nestjs/common';
import { z } from 'zod';

import { describeError } from '../../common/error-message';
import { TaskStatus } from '../../generated/prisma/enums';
import type { TaskService } from '../tasks/services/task.service';
import { MAX_TASK_TITLE_LENGTH, MIN_TASK_TITLE_LENGTH } from '../tasks/task.constants';
import { MeetingToolName } from './meeting-tool-names';
import { answered, refused, taskOf, textUpTo } from './meeting-tool-parts';
import type { ToolResult } from './meeting-tool-parts';

/**
 * A task's title as every server that writes one takes it: trimmed, and within the bounds
 * of what it is written to. One function for two shapes, so the two cannot come to disagree
 * about what a title is.
 */
export const taskTitleInput = (): z.ZodString =>
  textUpTo(MAX_TASK_TITLE_LENGTH, MIN_TASK_TITLE_LENGTH);

/**
 * A task's status, optional although the task has one: left out, an existing task keeps the
 * status it reached. Required, a caller restating a finished task would have to pick one,
 * and would reopen it.
 */
export const taskStatusInput = (): z.ZodOptional<z.ZodEnum<typeof TaskStatus>> =>
  z.enum(TaskStatus).optional();

const UPSERT_TASK_INPUT = {
  title: taskTitleInput().describe(
    'The task in one sentence. The title identifies the task: the same title updates it, another wording is another task.',
  ),
  status: taskStatusInput().describe(
    'Leave out to create the task as OPEN, or to keep the status an existing one has.',
  ),
};

export type UpsertTaskInput = z.infer<z.ZodObject<typeof UPSERT_TASK_INPUT>>;

/**
 * `upsert_task` as the stdio server describes it: a title and a status, and no meeting.
 *
 * **Not the shape a digest's run is handed**, which has the meeting's id among its
 * arguments, for a model that was given it and is checked against it (`MeetingTools`).
 * A client of the stdio server is a task manager's: the meeting is the process's, fixed
 * before anything connects, and nothing in the tool names one.
 *
 * `readOnlyHint` is said rather than left to its default: a client that decides what to
 * ask its user about reads it, and this is the tool that writes.
 */
export const UPSERT_TASK_TOOL = {
  name: MeetingToolName.UPSERT_TASK,
  description:
    'Creates a task, or updates the status of the task that already exists under the same title.',
  inputSchema: UPSERT_TASK_INPUT,
  annotations: { readOnlyHint: false },
} as const;

/**
 * What that `upsert_task` does, for the one meeting its server was made for: `TaskService`'s
 * upsert and nothing of its own — the title is the shape's to normalise, the rest the
 * service's.
 *
 * **It never throws**, as no tool does: the failure is logged through the caller's logger
 * and answered in a sentence of this file's own.
 */
export async function upsertTaskOf(
  tasks: TaskService,
  logger: Logger,
  meetingId: string,
  { title, status }: UpsertTaskInput,
): Promise<ToolResult> {
  try {
    return answered({
      task: taskOf(await tasks.upsert({ title, status, sourceMeetingId: meetingId })),
    });
  } catch (error) {
    logger.error(`Tool ${UPSERT_TASK_TOOL.name} failed`, describeError(error));

    return refused('The task could not be saved.');
  }
}
