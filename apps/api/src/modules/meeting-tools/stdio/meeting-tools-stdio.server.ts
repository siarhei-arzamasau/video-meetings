import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable, Logger } from '@nestjs/common';

import { TaskService } from '../../tasks/services/task.service';
import { FIND_TASKS_TOOL, findTasksOf } from '../find-tasks.tool';
import { MEETING_TOOLS_SERVER_NAME } from '../meeting-tool-names';

/** What the server tells a client it is at, in `initialize`. Moves when its tools change. */
export const MEETING_TOOLS_STDIO_VERSION = '1.0.0';

/**
 * The meeting's tools as an MCP server of its own, for a client that reaches it over a
 * transport instead of living in this process — today, `find_tasks` and no other.
 *
 * **The tool is the in-process server's, not a second one like it**: its name, description,
 * shape and behaviour are `FIND_TASKS_TOOL` and `findTasksOf`, which `MeetingTools` hands a
 * digest's run as well. What differs is only who serves it — `@modelcontextprotocol/sdk`
 * here, the Claude Agent SDK's toolkit there.
 *
 * **A server is made for one meeting, and its tool reaches no other**, for the reason the
 * in-process server's does: the meeting is not an argument, so nothing a model sends can
 * turn a search of one meeting's tasks into a search of every meeting's.
 */
@Injectable()
export class MeetingToolsStdioServer {
  private readonly logger = new Logger(MeetingToolsStdioServer.name);

  constructor(private readonly tasks: TaskService) {}

  /** A new server holding the tool, for the one meeting. Connected to nothing yet. */
  create(meetingId: string): McpServer {
    const server = new McpServer(
      { name: MEETING_TOOLS_SERVER_NAME, version: MEETING_TOOLS_STDIO_VERSION },
      // Said rather than left to the first `registerTool`: tools are what this server is.
      { capabilities: { tools: {} } },
    );

    server.registerTool(
      FIND_TASKS_TOOL.name,
      {
        description: FIND_TASKS_TOOL.description,
        inputSchema: FIND_TASKS_TOOL.inputSchema,
        annotations: FIND_TASKS_TOOL.annotations,
      },
      (input) => findTasksOf(this.tasks, this.logger, meetingId, input),
    );

    return server;
  }
}
