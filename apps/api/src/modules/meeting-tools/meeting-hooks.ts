import type { HookCallback, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { Injectable, Logger } from '@nestjs/common';

import { mcpToolName } from '../claude-agent/services/claude-agent-tools';
import type { ClaudeAgentHooks } from '../claude-agent/services/claude-agent-tools';
import { MIN_TASK_TITLE_LENGTH } from '../tasks/task.constants';
import { MEETING_TOOLS_SERVER_NAME, MeetingToolName } from './meeting-tools';

/** The most of a call's arguments, and of its result, that one line of the log carries. */
export const MAX_AUDITED_CHARACTERS = 1_000;

const UPSERT_TASK = mcpToolName(MEETING_TOOLS_SERVER_NAME, MeetingToolName.UPSERT_TASK);

/** What the name of every tool on the server begins with: `mcp__meeting__`. */
const MEETING_TOOL_PREFIX = mcpToolName(MEETING_TOOLS_SERVER_NAME, '');

/**
 * Claude Code reads a matcher that is only letters, digits, and underscores as a tool's whole
 * name (read in its 0.3.292 binary), and anything else as a regular expression. Anchored
 * here, rather than left to how that expression is applied.
 */
const ANY_MEETING_TOOL = `^${MEETING_TOOL_PREFIX}`;

type ToolCall = Extract<HookInput, { hook_event_name: 'PreToolUse' }>;
type FinishedToolCall = Extract<
  HookInput,
  { hook_event_name: 'PostToolUse' | 'PostToolUseFailure' }
>;

/** A hook that has nothing to say: the call goes on to whatever decides it next. */
const PASSED: HookJSONOutput = {};

const denied = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

const isMeetingToolCall = (input: HookInput): input is ToolCall =>
  input.hook_event_name === 'PreToolUse' && input.tool_name.startsWith(MEETING_TOOL_PREFIX);

const isFinishedMeetingToolCall = (input: HookInput): input is FinishedToolCall =>
  (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure') &&
  input.tool_name.startsWith(MEETING_TOOL_PREFIX);

/** The title a call gave, trimmed as the tool would trim it; nothing at all is a blank one. */
function titleOf(toolInput: unknown): string {
  const title: unknown =
    typeof toolInput === 'object' && toolInput !== null && 'title' in toolInput
      ? toolInput.title
      : undefined;

  return typeof title === 'string' ? title.trim() : '';
}

/** A value as one bounded line: JSON, so that a line break in it cannot start a log line. */
function auditedTextOf(value: unknown): string {
  let text: string;

  try {
    text = JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[not serialisable]';
  }

  return text.length > MAX_AUDITED_CHARACTERS
    ? `${text.slice(0, MAX_AUDITED_CHARACTERS)}… (${text.length} characters)`
    : text;
}

/**
 * What the process running the model asks this one before and after a call to a meeting
 * tool: two hooks that may refuse a call, and one that writes down every call that ran.
 *
 * **A refusal here is the model's to read, not a failure of the run.** The reason goes back
 * to the model in place of the tool's result, and the run goes on: it can state the task
 * properly, or answer. Neither hook stands in for a rule a tool keeps for itself — which
 * meeting a run may touch is `MeetingTools`', whatever is registered here.
 *
 * **Every hook checks the tool's name itself.** The matcher it is registered under decides
 * only whether the SDK asks; a hook that trusted it would count, or refuse, whatever a
 * differently read matcher let through — the SDK's own `StructuredOutput` among them, and a
 * run that is refused that tool can never answer.
 *
 * **No hook throws.** What Claude Code does with a hook that fails is its own to decide, and
 * for a hook whose job is to refuse, anything but a refusal is the call going ahead.
 */
@Injectable()
export class MeetingHooks {
  private readonly logger = new Logger(MeetingHooks.name);

  /**
   * The hooks of one run, as `query()`'s `options.hooks` takes them. **Made per run**: the
   * budget counts, and a count shared by two runs would refuse the second for the first's.
   */
  createHooks(maxToolCalls: number): ClaudeAgentHooks {
    return {
      PreToolUse: [
        { matcher: UPSERT_TASK, hooks: [this.preToolUseGuard] },
        { matcher: ANY_MEETING_TOOL, hooks: [this.callBudget(maxToolCalls)] },
      ],
      PostToolUse: [{ matcher: ANY_MEETING_TOOL, hooks: [this.auditLog] }],
      // A call that ran and failed is the one a record of calls is most often read for.
      PostToolUseFailure: [{ matcher: ANY_MEETING_TOOL, hooks: [this.auditLog] }],
    };
  }

  /**
   * Refuses an `upsert_task` whose title is blank or shorter than `MIN_TASK_TITLE_LENGTH`.
   * It reads the arguments as the model sent them, before the tool's own shape has trimmed
   * or checked anything, so the title may be missing or not text at all.
   *
   * **The tool's shape holds the same bound, and is what keeps it.** This hook is the same
   * rule said sooner and in words the model can act on: the shape's refusal is the SDK's
   * to phrase, and a server handed to a run without these hooks still refuses the title.
   */
  readonly preToolUseGuard: HookCallback = (input) => {
    if (!isMeetingToolCall(input) || input.tool_name !== UPSERT_TASK) {
      return Promise.resolve(PASSED);
    }

    const title = titleOf(input.tool_input);

    if (title.length >= MIN_TASK_TITLE_LENGTH) {
      return Promise.resolve(PASSED);
    }

    this.logger.warn(
      `Tool ${input.tool_name} denied: a title of ${title.length} character(s), ` +
        `under the ${MIN_TASK_TITLE_LENGTH} a task needs`,
    );

    return Promise.resolve(
      denied(
        `A task's title must be at least ${MIN_TASK_TITLE_LENGTH} characters long, and this ` +
          `one is ${title.length === 0 ? 'empty' : `"${title}"`}. State the task in one ` +
          'sentence and call the tool again, or leave it out if nothing was to be done.',
      ),
    );
  };

  /**
   * Counts the calls one run makes to the meeting's tools, and refuses every call past
   * `maxToolCalls`. A call counts when it is asked for, whether or not it then runs: one
   * the guard refuses has still been made.
   */
  callBudget(maxToolCalls: number): HookCallback {
    let calls = 0;

    return (input) => {
      if (!isMeetingToolCall(input)) {
        return Promise.resolve(PASSED);
      }

      calls += 1;

      if (calls <= maxToolCalls) {
        return Promise.resolve(PASSED);
      }

      this.logger.warn(
        `Tool ${input.tool_name} denied: call ${calls} of a run that may make ${maxToolCalls}`,
      );

      return Promise.resolve(
        denied(
          `This run may call its tools ${maxToolCalls} times and has. Call no tool again: ` +
            'answer now, with the digest of what you have read.',
        ),
      );
    };
  }

  /**
   * One line for every call to a meeting tool that ran: its name, its arguments, and its
   * result — or the error, for a call that failed.
   */
  readonly auditLog: HookCallback = (input) => {
    if (!isFinishedMeetingToolCall(input)) {
      return Promise.resolve(PASSED);
    }

    const outcome =
      input.hook_event_name === 'PostToolUse'
        ? `result ${auditedTextOf(input.tool_response)}`
        : `error ${auditedTextOf(input.error)}`;

    this.logger.log(
      `Tool ${input.tool_name} called: arguments ${auditedTextOf(input.tool_input)}, ${outcome}`,
    );

    return Promise.resolve(PASSED);
  };
}
