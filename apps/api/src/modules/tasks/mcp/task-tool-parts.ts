import type { TaskStatus } from '../../../generated/prisma/enums';

/** The names of the tools the tasks domain offers, as a client and a model see them. */
export enum TaskToolName {
  FIND_TASKS = 'find_tasks',
  UPSERT_TASK = 'upsert_task',
}

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
