import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { describeError } from '../../../common/error-message';
import { TaskService } from '../services/task.service';
import { OPEN_TASKS_LIMIT } from '../task.constants';
import { FIND_TASKS_TOOL, findTasksOf } from './find-tasks.tool';
import { admissionOf } from '../../mcp-registry/mcp-scope';
import type { McpRequester, McpScope } from '../../mcp-registry/mcp-scope';
import { refused } from '../../mcp-registry/mcp-tool-parts';
import type { ToolResult } from '../../mcp-registry/mcp-tool-parts';
import type { McpToolRegistrar } from '../../mcp-registry/mcp-tool-registrar';
import { McpToolRegistry } from '../../mcp-registry/mcp-tool-registry';
import { registerTaskPrompts } from './task-prompts';
import { OPEN_TASKS_RESOURCE_URI, TASK_RESOURCE_URI_TEMPLATE } from './task-resource-uris';
import { taskOf } from './task-tool-parts';
import { UPSERT_TASK_TOOL, upsertTaskOf } from './upsert-task.tool';

const JSON_MIME_TYPE = 'application/json';
const NO_SUCH_TASK = 'There is no such task.';
const NOT_READ = 'The tasks could not be read.';

/**
 * What the tasks domain offers over MCP, and the domain's own registrar for it: two tools,
 * `find_tasks` and `upsert_task`; two resources, the open tasks and one task by its id —
 * each of them one `TaskService` method, reached by injection, with nothing here that is a
 * second copy of the service's logic; and two prompts for gathering what the tasks say.
 *
 * **It adds itself to `McpToolRegistry` as its module starts**, which is all it takes for
 * a server to offer these: no MCP module names this class. A server that expects it has to
 * import `TasksModule`, so that this runs before the server is built (the registry says
 * why, and refuses a registrar that comes late).
 *
 * **Everything is registered for a scope: one meeting, and a gate asked before every call
 * and every read** (`mcp-scope.ts`). What these answer with is a meeting's tasks.
 *
 * **Nothing here throws at a client in words it did not choose.** A tool answers `isError`
 * with a sentence of this domain's own; a resource throws an `McpError` made here, because
 * the SDK hands a thrown error's message to the client as it is. The cause is the log's.
 */
@Injectable()
export class TaskTools implements McpToolRegistrar, OnModuleInit {
  private readonly logger = new Logger(TaskTools.name);

  constructor(
    private readonly tasks: TaskService,
    private readonly registry: McpToolRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.add(this);
  }

  /** Registers the two tools, the two resources and the two prompts on `server`. */
  register(server: McpServer, scope: McpScope): void {
    this.registerTools(server, scope);
    this.registerResources(server, scope);
    // Text and nothing read, so not behind the scope's gate (`task-prompts.ts`).
    registerTaskPrompts(server);
  }

  /**
   * `find_tasks` is the in-process server's tool, not a second one like it: its name,
   * description, shape and behaviour are `FIND_TASKS_TOOL` and `findTasksOf`, which
   * `MeetingTools` hands a digest's run as well. `upsert_task` is the same service under a
   * shape with no meeting in it (`upsert-task.tool.ts`).
   */
  private registerTools(server: McpServer, scope: McpScope): void {
    const { meetingId } = scope;

    server.registerTool(
      FIND_TASKS_TOOL.name,
      {
        description: FIND_TASKS_TOOL.description,
        inputSchema: FIND_TASKS_TOOL.inputSchema,
        annotations: FIND_TASKS_TOOL.annotations,
      },
      (input) => this.call(scope, () => findTasksOf(this.tasks, this.logger, meetingId, input)),
    );
    server.registerTool(
      UPSERT_TASK_TOOL.name,
      {
        description: UPSERT_TASK_TOOL.description,
        inputSchema: UPSERT_TASK_TOOL.inputSchema,
        annotations: UPSERT_TASK_TOOL.annotations,
      },
      (input) => this.call(scope, () => upsertTaskOf(this.tasks, this.logger, meetingId, input)),
    );
  }

  /**
   * The list is the scope's meeting's. A task is addressed by an id its reader chose, so it
   * is answered only when it came out of that meeting — otherwise an id from anywhere would
   * read a task of a meeting its reader cannot see.
   */
  private registerResources(server: McpServer, scope: McpScope): void {
    server.registerResource(
      'open-tasks',
      OPEN_TASKS_RESOURCE_URI,
      {
        title: 'Open tasks',
        description: `The tasks that are still open, the oldest first — at most ${OPEN_TASKS_LIMIT}.`,
        mimeType: JSON_MIME_TYPE,
      },
      (uri) => this.read(scope, uri, () => this.openTasks(scope.meetingId)),
    );
    server.registerResource(
      'task',
      // `list: undefined` is the SDK's way to say the template lists nothing, said on purpose.
      new ResourceTemplate(TASK_RESOURCE_URI_TEMPLATE, { list: undefined }),
      { title: 'Task', description: 'One task, by its id.', mimeType: JSON_MIME_TYPE },
      (uri, { taskId }) =>
        this.read(scope, uri, (requester) => this.task(scope.meetingId, String(taskId), requester)),
    );
  }

  private async openTasks(meetingId: string): Promise<object> {
    return { tasks: (await this.tasks.open(meetingId)).map(taskOf) };
  }

  /**
   * One task of the meeting, or `null` for an id that is not a task of it — not a UUID, no
   * such task, or another meeting's, which are one answer on purpose.
   *
   * `_requester` is who is asking. Nothing is decided by it yet: whoever may read the
   * meeting may read each of its tasks, a task having no assignee. It is here for the rule
   * that will.
   */
  private async task(
    meetingId: string,
    taskId: string,
    _requester: McpRequester,
  ): Promise<object | null> {
    if (!z.uuid().safeParse(taskId).success) {
      return null;
    }

    const task = await this.tasks.get(taskId);

    return task === null || task.sourceMeetingId !== meetingId ? null : { task: taskOf(task) };
  }

  /** A tool's own work, run for whoever the gate lets in and refused to anybody else. */
  private async call(scope: McpScope, run: () => Promise<ToolResult>): Promise<ToolResult> {
    const admission = await admissionOf(scope, this.logger);

    return 'requester' in admission ? run() : refused(admission.refusal);
  }

  /** The gate, the read, and the answer as the JSON text of one resource. */
  private async read(
    scope: McpScope,
    uri: URL,
    answerFor: (requester: McpRequester) => Promise<object | null>,
  ): Promise<ReadResourceResult> {
    const admission = await admissionOf(scope, this.logger);

    if (!('requester' in admission)) {
      throw new McpError(ErrorCode.InvalidRequest, admission.refusal);
    }

    let answer: object | null;

    try {
      answer = await answerFor(admission.requester);
    } catch (error) {
      this.logger.error('A resource could not be read', describeError(error));

      throw new McpError(ErrorCode.InternalError, NOT_READ);
    }

    if (answer === null) {
      throw new McpError(ErrorCode.InvalidParams, NO_SUCH_TASK);
    }

    return {
      contents: [{ uri: uri.href, mimeType: JSON_MIME_TYPE, text: JSON.stringify(answer) }],
    };
  }
}
