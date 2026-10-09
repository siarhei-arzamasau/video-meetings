import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { z } from 'zod';

import { describeError } from '../../common/error-message';
import { TaskStatus } from '../../generated/prisma/enums';
import { ClaudeAgentToolkitLoader } from '../claude-agent/services/claude-agent-toolkit.loader';
import {
  MeetingDigestRevisionOutcome,
  ReviseMeetingDigestCommand,
} from '../meeting-digests/commands/revise-meeting-digest.command';
import {
  MAX_DIGEST_ITEMS,
  MAX_DIGEST_ITEM_LENGTH,
  MAX_DIGEST_SUMMARY_LENGTH,
} from '../meeting-digests/meeting-digest.constants';
import { TaskService } from '../tasks/services/task.service';
import { MAX_TASK_TITLE_LENGTH, MIN_TASK_TITLE_LENGTH } from '../tasks/task.constants';

/** The server's name, and so the prefix of its tools as an agent sees them: `mcp__meeting__`. */
export const MEETING_TOOLS_SERVER_NAME = 'meeting';

export enum MeetingToolName {
  FIND_TASKS = 'find_tasks',
  UPSERT_TASK = 'upsert_task',
  UPDATE_MEETING = 'update_meeting',
}

/** Text with something in it, trimmed, and no longer than `maxLength`. */
const textUpTo = (maxLength: number, minLength = 1): z.ZodString =>
  z.string().trim().min(minLength).max(maxLength);

const FIND_TASKS_INPUT = {
  query: textUpTo(MAX_TASK_TITLE_LENGTH).describe('What the task is about, or its title.'),
};

const UPSERT_TASK_INPUT = {
  title: textUpTo(MAX_TASK_TITLE_LENGTH, MIN_TASK_TITLE_LENGTH).describe(
    'The task in one sentence. With the meeting it identifies the task: the same title updates it, another wording is another task.',
  ),
  status: z
    .enum(TaskStatus)
    .optional()
    .describe('Leave out to create the task as OPEN, or to keep the status an existing one has.'),
  sourceMeetingId: z.uuid().describe('The id of the meeting the task came out of.'),
};

const UPDATE_MEETING_INPUT = {
  meetingId: z.uuid().describe('The id of the meeting.'),
  summary: textUpTo(MAX_DIGEST_SUMMARY_LENGTH).describe('The summary of the meeting, whole.'),
  decisions: z
    .array(textUpTo(MAX_DIGEST_ITEM_LENGTH))
    .max(MAX_DIGEST_ITEMS)
    .describe('Every decision the meeting made, one sentence each. They replace the stored ones.'),
};

type FindTasksInput = z.infer<z.ZodObject<typeof FIND_TASKS_INPUT>>;
type UpsertTaskInput = z.infer<z.ZodObject<typeof UPSERT_TASK_INPUT>>;
type UpdateMeetingInput = z.infer<z.ZodObject<typeof UPDATE_MEETING_INPUT>>;

type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;

/** What `update_meeting` says when nothing was written. For the model, never for a user. */
const UPDATE_REFUSALS: Record<
  Exclude<MeetingDigestRevisionOutcome, MeetingDigestRevisionOutcome.REVISED>,
  string
> = {
  [MeetingDigestRevisionOutcome.NO_DIGEST]:
    'This meeting has no digest yet, so there is no summary to update.',
  [MeetingDigestRevisionOutcome.UNFIT]: 'The summary or a decision is blank or too long.',
};

/** What a tool that writes says to an id other than the one its server was made for. */
const OTHER_MEETING = 'These tools work on one meeting, and that is not its id.';

const sameMeeting = (given: string, bound: string): boolean =>
  given.toLowerCase() === bound.toLowerCase();

const answered = (answer: object): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(answer) }],
});

const refused = (reason: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: reason }],
});

/** A task as a tool answers with it: what identifies it and where it stands, no timestamps. */
const taskOf = ({
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

/**
 * The API's own services as tools an agent can call: tasks searched and written through
 * `TaskService`, and a meeting's summary and decisions through the digest's revision. One
 * MCP server, `meeting`, that lives in this process — no port, and no second process.
 *
 * **A server is made for one meeting, and its tools reach no other.** The ids are arguments,
 * so the model chooses them, and what it reads is what people said: a transcript that names
 * another meeting must not be able to write there, or to be answered with its tasks. So
 * `find_tasks` searches the one meeting, and the two that write refuse any other id — a
 * rule kept here, in code, whatever the instructions of a run say.
 *
 * **A tool never throws.** A failure is logged here and answered as an error with a
 * sentence of this file's own: what a thrown error says — a constraint's name, a statement
 * — would otherwise be the SDK's to hand to the model.
 */
@Injectable()
export class MeetingTools {
  private readonly logger = new Logger(MeetingTools.name);

  constructor(
    private readonly sdk: ClaudeAgentToolkitLoader,
    private readonly tasks: TaskService,
    private readonly commands: CommandBus,
  ) {}

  /**
   * A new server holding the three tools, for the one meeting. Loads the SDK, and sends
   * nothing anywhere.
   */
  async createServer(meetingId: string): Promise<McpSdkServerConfigWithInstance> {
    const { tool, createSdkMcpServer } = await this.sdk.loadToolkit();

    return createSdkMcpServer({
      name: MEETING_TOOLS_SERVER_NAME,
      tools: [
        tool(
          MeetingToolName.FIND_TASKS,
          'Finds the tasks this meeting already has whose title is similar to the text, the most similar first. Use it before creating a task, to see whether it already exists.',
          FIND_TASKS_INPUT,
          (input) => this.findTasks(meetingId, input),
          { annotations: { readOnlyHint: true } },
        ),
        tool(
          MeetingToolName.UPSERT_TASK,
          'Creates a task of a meeting, or updates the status of the task that meeting already has under the same title.',
          UPSERT_TASK_INPUT,
          (input) => this.upsertTask(meetingId, input),
        ),
        tool(
          MeetingToolName.UPDATE_MEETING,
          "Replaces the summary and the decisions of a meeting's digest. The meeting must already have a digest.",
          UPDATE_MEETING_INPUT,
          (input) => this.updateMeeting(meetingId, input),
        ),
      ],
    });
  }

  private async findTasks(meetingId: string, { query }: FindTasksInput): Promise<ToolResult> {
    try {
      return answered({ tasks: (await this.tasks.search(query, meetingId)).map(taskOf) });
    } catch (error) {
      return this.failed(MeetingToolName.FIND_TASKS, error, 'The tasks could not be searched.');
    }
  }

  private async upsertTask(
    meetingId: string,
    { title, status, sourceMeetingId }: UpsertTaskInput,
  ): Promise<ToolResult> {
    if (!sameMeeting(sourceMeetingId, meetingId)) {
      return refused(OTHER_MEETING);
    }

    try {
      return answered({
        task: taskOf(await this.tasks.upsert({ title, status, sourceMeetingId: meetingId })),
      });
    } catch (error) {
      // A meeting that is gone ends here too: it is the foreign key's error, like any other.
      return this.failed(
        MeetingToolName.UPSERT_TASK,
        error,
        'The task could not be saved. Check the meeting id.',
      );
    }
  }

  private async updateMeeting(
    boundMeetingId: string,
    { meetingId, summary, decisions }: UpdateMeetingInput,
  ): Promise<ToolResult> {
    if (!sameMeeting(meetingId, boundMeetingId)) {
      return refused(OTHER_MEETING);
    }

    try {
      const outcome = await this.commands.execute<
        ReviseMeetingDigestCommand,
        MeetingDigestRevisionOutcome
      >(new ReviseMeetingDigestCommand(boundMeetingId, summary, decisions));

      return outcome === MeetingDigestRevisionOutcome.REVISED
        ? answered({ meetingId: boundMeetingId, updated: true })
        : refused(UPDATE_REFUSALS[outcome]);
    } catch (error) {
      return this.failed(
        MeetingToolName.UPDATE_MEETING,
        error,
        'The meeting could not be updated.',
      );
    }
  }

  private failed(toolName: MeetingToolName, error: unknown, reason: string): ToolResult {
    this.logger.error(`Tool ${toolName} failed`, describeError(error));

    return refused(reason);
  }
}
