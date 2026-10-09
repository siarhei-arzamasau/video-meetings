import type { McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk';

/**
 * Tools of the API's own that one run may call: an MCP server that lives in this process,
 * and the names of the tools on it the run is allowed. Whoever passes this has decided
 * what a prompt may then make the process do — nothing here narrows it further.
 */
export interface ClaudeAgentTools {
  /**
   * Makes the server. **A function, and called only when a process is about to be
   * started**: making a server loads the SDK, which Jest cannot, so a caller that made one
   * up front would fail in every suite that stands a fake in the service's place.
   */
  createServer: () => Promise<McpSdkServerConfigWithInstance>;
  /** The server's tools the run may call, by the names they were described under. */
  toolNames: ReadonlyArray<string>;
  /**
   * Makes the hooks the process asks before and after a tool call. **A function, called
   * once for each process started**: a hook may keep count of a run, and hooks made once
   * and handed to two runs would count them as one. Left out, the run has no hook.
   */
  createHooks?: () => ClaudeAgentHooks;
  /** The most turns the run may take. Left out, `MAX_TOOL_RUN_TURNS`. */
  maxTurns?: number;
}

/** Hooks as `query()` takes them: by event, each a matcher over tool names and callbacks. */
export type ClaudeAgentHooks = NonNullable<Options['hooks']>;

/**
 * The most turns a run that holds tools may take, where one prompt and one answer is 1.
 *
 * **Not measured against the cap itself.** On 2026-10-09, SDK 0.3.292 and
 * `claude-sonnet-5-5`, a run that looked for two tasks, wrote them, and answered reported
 * `num_turns: 6` and ended well under this cap — and `num_turns` is not the count the cap
 * is held against: a one-turn answer reports 2 under a cap of 1. So this is room for a few
 * rounds of tool calls more than were seen, and a bound on what a run that keeps calling
 * tools costs, since every round reads the whole prompt again. A run stopped by it is a
 * failure, `error_max_turns`, and what it had written through its tools stays written.
 */
export const MAX_TOOL_RUN_TURNS = 20;

/**
 * The turns a run is left once it has made every tool call it is allowed: some to be
 * refused a further call in, and one to answer.
 */
const TURNS_PAST_THE_LAST_TOOL_CALL = 5;

/**
 * The turn cap for a run whose hooks stop it at `maxToolCalls` calls.
 *
 * **The cap has to be past the budget, or the budget is never what stops a run.** A model
 * that calls one tool a turn spends a turn on each call, and the cap ends the run as a
 * failure — while a call a hook refuses only tells the model so, and leaves it to answer.
 * With both at twenty, the twenty-first call would be the one to refuse, in a turn the run
 * does not have. On 2026-10-09 a run allowed one call, under a cap of six, was refused its
 * second and answered with its digest; a run at a budget of twenty was not made.
 */
export const turnsForToolCalls = (maxToolCalls: number): number =>
  maxToolCalls + TURNS_PAST_THE_LAST_TOOL_CALL;

/** How Claude Code names a tool of an MCP server, which is how `allowedTools` names it. */
export const mcpToolName = (serverName: string, toolName: string): string =>
  `mcp__${serverName}__${toolName}`;

/**
 * The options that hand a run its tools: the server, the tools on it that are allowed,
 * turns enough to use them, and the caller's hooks if it has any.
 *
 * **`allowedTools` is the whole of what the run may call.** The process still holds no
 * built-in tool (`tools: []`) and `dontAsk` denies whatever is not listed, so a tool the
 * server has and this list does not is one the model is refused — as is every tool of any
 * other server, there being none: `strictMcpConfig` keeps `.mcp.json` out as before.
 *
 * **A hook can only take away.** One that answers `deny` refuses a call `allowedTools`
 * would have let through, and the model reads its reason; nothing a hook answers is
 * relied on to let a call through that the list does not name.
 */
export async function toolOptionsOf({
  createServer,
  toolNames,
  createHooks,
  maxTurns = MAX_TOOL_RUN_TURNS,
}: ClaudeAgentTools): Promise<Pick<Options, 'mcpServers' | 'allowedTools' | 'maxTurns' | 'hooks'>> {
  const server = await createServer();

  return {
    mcpServers: { [server.name]: server },
    allowedTools: toolNames.map((toolName) => mcpToolName(server.name, toolName)),
    maxTurns,
    ...(createHooks === undefined ? {} : { hooks: createHooks() }),
  };
}
