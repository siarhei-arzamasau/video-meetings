/** The server's name, and so the prefix of its tools as an agent sees them: `mcp__meeting__`. */
export const MEETING_TOOLS_SERVER_NAME = 'meeting';

export enum MeetingToolName {
  FIND_TASKS = 'find_tasks',
  UPSERT_TASK = 'upsert_task',
  UPDATE_MEETING = 'update_meeting',
}
