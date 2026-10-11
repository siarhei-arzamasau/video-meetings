import { TaskToolName } from '../tasks/mcp/task-tool-parts';

/** The server's name, and so the prefix of its tools as an agent sees them: `mcp__meeting__`. */
export const MEETING_TOOLS_SERVER_NAME = 'meeting';

/**
 * The three tools a digest's run is handed. The two that keep tasks are the tasks domain's,
 * under the names it gives them; the third is this module's own.
 */
export enum MeetingToolName {
  FIND_TASKS = TaskToolName.FIND_TASKS,
  UPSERT_TASK = TaskToolName.UPSERT_TASK,
  UPDATE_MEETING = 'update_meeting',
}
