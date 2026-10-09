import type { HookCallback, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export const MEETING_ID = '44444444-4444-4444-8444-444444444444';

export const FIND_TASKS = 'mcp__meeting__find_tasks';
export const UPSERT_TASK = 'mcp__meeting__upsert_task';
export const UPDATE_MEETING = 'mcp__meeting__update_meeting';

/** The tool the SDK answers through. A run refused it can never end. */
export const STRUCTURED_OUTPUT = 'StructuredOutput';

/** What every hook input carries, whatever the event. */
const RUN = { session_id: 'a-session', transcript_path: '', cwd: '/' };

/** A call being asked for: what `PreToolUse` hands a hook. */
export const asked = (toolName: string, toolInput: unknown): HookInput => ({
  ...RUN,
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 'a-call',
});

/** A call that ran: what `PostToolUse` hands a hook. */
export const finished = (
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
): HookInput => ({
  ...RUN,
  hook_event_name: 'PostToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_response: toolResponse,
  tool_use_id: 'a-call',
});

/** A call that ran and failed: what `PostToolUseFailure` hands a hook. */
export const failed = (toolName: string, toolInput: unknown, error: string): HookInput => ({
  ...RUN,
  hook_event_name: 'PostToolUseFailure',
  tool_name: toolName,
  tool_input: toolInput,
  error,
  tool_use_id: 'a-call',
});

/** Calls a hook as the SDK does. */
export const run = (hook: HookCallback, input: HookInput): Promise<HookJSONOutput> =>
  hook(input, 'a-call', { signal: new AbortController().signal });

/** The answer of a hook that refuses a call, with `reason` as what the model reads. */
export const denialWith = (reason: unknown): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason as string,
  },
});
