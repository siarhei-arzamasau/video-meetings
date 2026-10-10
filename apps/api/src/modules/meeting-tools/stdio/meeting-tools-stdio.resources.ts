import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '@nestjs/common';
import { z } from 'zod';

import { describeError } from '../../../common/error-message';
import type { TaskService } from '../../tasks/services/task.service';
import { OPEN_TASKS_LIMIT } from '../../tasks/task.constants';
import { taskOf } from '../meeting-tool-parts';
import type { MeetingToolsRequester } from './meeting-tools-stdio.access';

/** The fixed address of the list of open tasks. */
export const OPEN_TASKS_RESOURCE_URI = 'tasks://open';
/** The address of one task. A template: its tasks are found by search, not by listing. */
export const TASK_RESOURCE_URI_TEMPLATE = 'task://{taskId}';

const JSON_MIME_TYPE = 'application/json';
const NO_SUCH_TASK = 'There is no such task.';
const NOT_READ = 'The tasks could not be read.';

/** The requester a read is made for, or the sentence it is refused with. */
export type Admitted = { requester: MeetingToolsRequester } | { refusal: string };

/** What a server's resources are read through: its tasks, its one meeting, and its gate. */
export interface TaskResourcesContext {
  tasks: TaskService;
  logger: Logger;
  meetingId: string;
  /** Asked before every read, as before every tool call (`MeetingToolsStdioServer`). */
  admit: () => Promise<Admitted>;
}

type Read = (requester: MeetingToolsRequester) => Promise<object | null>;

/**
 * The server's two resources: the meeting's open tasks at a fixed address, and one task at
 * an address made from its id. Both are `TaskService`'s reads, answered as JSON.
 *
 * **Both are read for the server's one meeting and its one user**, like its tools. The
 * list is the meeting's. A task is addressed by an id its reader chose, so it is answered
 * only when it came out of that meeting — otherwise an id from anywhere would read a task
 * of a meeting its reader cannot see.
 *
 * **A read that cannot be answered is an error of this file's wording**, never the one that
 * was thrown: the SDK hands a thrown error's message to the client as it is.
 */
export function registerTaskResources(server: McpServer, context: TaskResourcesContext): void {
  server.registerResource(
    'open-tasks',
    OPEN_TASKS_RESOURCE_URI,
    {
      title: 'Open tasks',
      description: `The tasks that are still open, the oldest first — at most ${OPEN_TASKS_LIMIT}.`,
      mimeType: JSON_MIME_TYPE,
    },
    (uri) => readAs(context, uri, () => readOpenTasks(context)),
  );
  server.registerResource(
    'task',
    // `list: undefined` is the SDK's way to say the template lists nothing, said on purpose.
    new ResourceTemplate(TASK_RESOURCE_URI_TEMPLATE, { list: undefined }),
    { title: 'Task', description: 'One task, by its id.', mimeType: JSON_MIME_TYPE },
    (uri, { taskId }) =>
      readAs(context, uri, (requester) => readTask(context, String(taskId), requester)),
  );
}

async function readOpenTasks({ tasks, meetingId }: TaskResourcesContext): Promise<object> {
  return { tasks: (await tasks.open(meetingId)).map(taskOf) };
}

/**
 * One task of the server's meeting, or `null` for an id that is not a task of it — not a
 * UUID, no such task, or another meeting's, which are one answer on purpose.
 *
 * `_requester` is who is asking. Nothing is decided by it yet: whoever may read the meeting
 * may read each of its tasks, a task having no assignee. It is here for the rule that will.
 */
async function readTask(
  { tasks, meetingId }: TaskResourcesContext,
  taskId: string,
  _requester: MeetingToolsRequester,
): Promise<object | null> {
  if (!z.uuid().safeParse(taskId).success) {
    return null;
  }

  const task = await tasks.get(taskId);

  return task === null || task.sourceMeetingId !== meetingId ? null : { task: taskOf(task) };
}

/** The gate, the read, and the answer as the JSON text of one resource. */
async function readAs(
  context: TaskResourcesContext,
  uri: URL,
  read: Read,
): Promise<ReadResourceResult> {
  const answer = await answerOrError(context, read);

  return { contents: [{ uri: uri.href, mimeType: JSON_MIME_TYPE, text: JSON.stringify(answer) }] };
}

async function answerOrError({ admit, logger }: TaskResourcesContext, read: Read): Promise<object> {
  const requester = await requesterOrError(admit, logger);
  let answer: object | null;

  try {
    answer = await read(requester);
  } catch (error) {
    logger.error('A resource could not be read', describeError(error));

    throw new McpError(ErrorCode.InternalError, NOT_READ);
  }

  if (answer === null) {
    throw new McpError(ErrorCode.InvalidParams, NO_SUCH_TASK);
  }

  return answer;
}

/**
 * Who a read is for. **Let in only by a requester, never by the absence of a refusal**: a
 * gate that answered something else — or threw — is a gate that did not let anyone in.
 */
async function requesterOrError(
  admit: TaskResourcesContext['admit'],
  logger: Logger,
): Promise<MeetingToolsRequester> {
  let admitted: Admitted;

  try {
    admitted = await admit();
  } catch (error) {
    logger.error('Access to a resource could not be checked', describeError(error));

    throw new McpError(ErrorCode.InternalError, NOT_READ);
  }

  if (!('requester' in admitted)) {
    throw new McpError(ErrorCode.InvalidRequest, admitted.refusal);
  }

  return admitted.requester;
}
