import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable, Logger } from '@nestjs/common';

import { describeError } from '../../../common/error-message';
import { TaskService } from '../../tasks/services/task.service';
import { FIND_TASKS_TOOL, findTasksOf } from '../find-tasks.tool';
import { MEETING_TOOLS_SERVER_NAME } from '../meeting-tool-names';
import { refused } from '../meeting-tool-parts';
import type { ToolResult } from '../meeting-tool-parts';
import { UPSERT_TASK_TOOL, upsertTaskOf } from '../upsert-task.tool';
import {
  MEETING_TOOLS_STDIO_REFUSALS,
  MeetingToolsStdioAccess,
  MeetingToolsStdioAccessOutcome,
} from './meeting-tools-stdio.access';
import { registerMeetingPrompts } from './meeting-tools-stdio.prompts';
import { registerTaskResources } from './meeting-tools-stdio.resources';
import type { Admitted } from './meeting-tools-stdio.resources';

/** What the server tells a client it is at, in `initialize`. Moves when its tools change. */
export const MEETING_TOOLS_STDIO_VERSION = '1.1.0';

/** One sentence for a check that failed, whatever was asked for: the cause is the log's. */
const ACCESS_NOT_CHECKED = 'Access to the tasks could not be checked.';

/** A tool's own work, held back until its caller has been checked. */
type Run = () => Promise<ToolResult>;

/**
 * The meeting's tasks as an MCP server of its own, for a client that reaches it over a
 * transport instead of living in this process: two tools (`find_tasks`, `upsert_task`), two
 * resources (the open tasks, and one task by its id), and two prompts for gathering what is
 * known about the meeting. Everything that reads or writes is `TaskService`'s.
 *
 * **`find_tasks` is the in-process server's tool, not a second one like it**: its name,
 * description, shape and behaviour are `FIND_TASKS_TOOL` and `findTasksOf`, which
 * `MeetingTools` hands a digest's run as well. `upsert_task` is the same service under a
 * shape of this server's own, with no meeting in it (`upsert-task.tool.ts`).
 *
 * **A server is made for one meeting, and nothing in it reaches another**, for the reason
 * the in-process server's tools do not: the meeting is not an argument, so nothing a model
 * sends can turn a search of one meeting's tasks into a search of every meeting's, or write
 * a task there.
 *
 * **And for one user, whose access is checked before every call and every read.** A
 * digest's run is handed its server by the API, for the meeting the API is generating for.
 * This one is started by somebody outside it, who names the meeting — so the token they
 * hand over is checked against it each time, as a route checks each request: a process
 * outlives a token, and a session must not.
 */
@Injectable()
export class MeetingToolsStdioServer {
  private readonly logger = new Logger(MeetingToolsStdioServer.name);

  constructor(
    private readonly tasks: TaskService,
    private readonly access: MeetingToolsStdioAccess,
  ) {}

  /** A new server for the one meeting and user. Connected to nothing yet. */
  create(meetingId: string, accessToken: string): McpServer {
    const server = new McpServer(
      { name: MEETING_TOOLS_SERVER_NAME, version: MEETING_TOOLS_STDIO_VERSION },
      // Said rather than left to the first registration of each: these are what it serves.
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    const admit = (): Promise<Admitted> => this.admit(meetingId, accessToken);

    this.registerTools(server, meetingId, admit);
    registerTaskResources(server, { tasks: this.tasks, logger: this.logger, meetingId, admit });
    registerMeetingPrompts(server);

    return server;
  }

  private registerTools(
    server: McpServer,
    meetingId: string,
    admit: () => Promise<Admitted>,
  ): void {
    const forItsUser = async (run: Run): Promise<ToolResult> => {
      const admitted = await admit();

      // Let in by a requester, never by the absence of a refusal.
      return 'requester' in admitted ? run() : refused(admitted.refusal);
    };

    server.registerTool(
      FIND_TASKS_TOOL.name,
      {
        description: FIND_TASKS_TOOL.description,
        inputSchema: FIND_TASKS_TOOL.inputSchema,
        annotations: FIND_TASKS_TOOL.annotations,
      },
      (input) => forItsUser(() => findTasksOf(this.tasks, this.logger, meetingId, input)),
    );
    server.registerTool(
      UPSERT_TASK_TOOL.name,
      {
        description: UPSERT_TASK_TOOL.description,
        inputSchema: UPSERT_TASK_TOOL.inputSchema,
        annotations: UPSERT_TASK_TOOL.annotations,
      },
      (input) => forItsUser(() => upsertTaskOf(this.tasks, this.logger, meetingId, input)),
    );
  }

  /**
   * The gate every tool and resource is behind: who is asking, for a user who may read the
   * meeting, or the sentence they are refused with. **A check that fails is a refusal,
   * never a way in**: an error here — the database gone — must not leave anything open,
   * and like every tool this does not throw.
   */
  private async admit(meetingId: string, accessToken: string): Promise<Admitted> {
    try {
      const admission = await this.access.check(accessToken, meetingId);

      if (admission.outcome === MeetingToolsStdioAccessOutcome.GRANTED) {
        return { requester: admission.requester };
      }

      this.logger.warn(`A request was refused: ${admission.outcome}`);

      return { refusal: MEETING_TOOLS_STDIO_REFUSALS[admission.outcome] };
    } catch (error) {
      this.logger.error('Access to the meeting could not be checked', describeError(error));

      return { refusal: ACCESS_NOT_CHECKED };
    }
  }
}
