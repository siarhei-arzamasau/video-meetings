import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

import { ClaudeAgentFailure } from '../claude-agent.constants';
import {
  STRUCTURED_PROMPT,
  answering,
  claudeAgentOver,
  requestOf,
} from './claude-agent-process.fixture';
import { MAX_TOOL_RUN_TURNS } from './claude-agent-tools';

/** A server as `createSdkMcpServer` answers with one, down to what the service reads of it. */
const SERVER = { type: 'sdk', name: 'meeting' } as McpSdkServerConfigWithInstance;

/**
 * What a schema-bound call is started with once its caller names tools of the API's own:
 * that server and no other, those tools and no others, and everything else the process is
 * denied exactly as it is without them. How the real process then behaves is `test:live`'s.
 */
describe('ClaudeAgentService, for a prompt that is handed tools', () => {
  const createServer = jest.fn();
  const withTools = {
    ...STRUCTURED_PROMPT,
    tools: { createServer, toolNames: ['find_tasks', 'upsert_task'] },
  };
  const neverAborted = new AbortController().signal;

  beforeEach(() => {
    createServer.mockReset().mockResolvedValue(SERVER);
  });

  it('starts the process with the server, and allows its named tools and nothing else', async () => {
    const { claudeAgent, started } = claudeAgentOver(answering);

    await claudeAgent.runStructuredPrompt(withTools, neverAborted);

    const { options } = requestOf(started);
    expect(options.mcpServers).toEqual({ meeting: SERVER });
    expect(options.allowedTools).toEqual(['mcp__meeting__find_tasks', 'mcp__meeting__upsert_task']);
    expect(createServer).toHaveBeenCalledTimes(1);
  });

  it('gives the run turns enough to use them, and takes nothing else away from the rest', async () => {
    const { claudeAgent, started } = claudeAgentOver(answering);

    await claudeAgent.runStructuredPrompt(withTools, neverAborted);

    const { options } = requestOf(started);
    expect(options).toMatchObject({
      maxTurns: MAX_TOOL_RUN_TURNS,
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      persistSession: false,
      systemPrompt: STRUCTURED_PROMPT.systemPrompt,
      outputFormat: { type: 'json_schema', schema: STRUCTURED_PROMPT.schema },
    });
    // Still no built-in tool: what the run may touch is what the server offers.
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
  });

  it("starts the process with the caller's hooks, made once for it, and the turns it asked for", async () => {
    const { claudeAgent, started } = claudeAgentOver(answering);
    const hooks = { PreToolUse: [{ matcher: 'mcp__meeting__upsert_task', hooks: [] }] };
    const createHooks = jest.fn().mockReturnValue(hooks);
    const bounded = { ...withTools, tools: { ...withTools.tools, createHooks, maxTurns: 8 } };

    await claudeAgent.runStructuredPrompt(bounded, neverAborted);

    const { options } = requestOf(started);
    expect(options.hooks).toBe(hooks);
    expect(options.maxTurns).toBe(8);
    expect(createHooks).toHaveBeenCalledTimes(1);

    // A second process is a second run: its hooks are its own, so a count starts again.
    await claudeAgent.runStructuredPrompt(bounded, neverAborted);
    expect(createHooks).toHaveBeenCalledTimes(2);
  });

  it('registers no hook for a caller that names none', async () => {
    const { claudeAgent, started } = claudeAgentOver(answering);

    await claudeAgent.runStructuredPrompt(withTools, neverAborted);

    expect(requestOf(started).options).not.toHaveProperty('hooks');
  });

  it('holds no server, no allowed tool, and one turn for a prompt that names no tools', async () => {
    const { claudeAgent, started } = claudeAgentOver(answering);

    await claudeAgent.runStructuredPrompt(STRUCTURED_PROMPT, neverAborted);

    const { options } = requestOf(started);
    expect(options.mcpServers).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(options.hooks).toBeUndefined();
    expect(options.maxTurns).toBe(1);
  });

  it('makes no server for a call that was called off before it began', async () => {
    const { claudeAgent, started } = claudeAgentOver(answering);
    const calledOff = AbortSignal.abort(new Error('shutting down'));

    await expect(claudeAgent.runStructuredPrompt(withTools, calledOff)).rejects.toMatchObject({
      failure: ClaudeAgentFailure.FAILED,
    });

    expect(createServer).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it('starts no process when the server cannot be made, and lets that failure through', async () => {
    const { claudeAgent, started } = claudeAgentOver(answering);
    const failure = new Error('the SDK could not be loaded');
    createServer.mockRejectedValue(failure);

    await expect(claudeAgent.runStructuredPrompt(withTools, neverAborted)).rejects.toBe(failure);

    expect(started).not.toHaveBeenCalled();
  });
});
