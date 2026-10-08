import { ClaudeAgentFailure } from '../../src/modules/claude-agent/claude-agent.constants';
import { ClaudeAgentError } from '../../src/modules/claude-agent/claude-agent.error';
import type {
  ClaudeStructuredPrompt,
  ClaudeStructuredReply,
} from '../../src/modules/claude-agent/services/claude-agent.service';
import { CLAUDE_MARKER, FAKE_COST_USD, FAKE_MODEL } from '../utils/fake-claude-agent';
import type { DigestHolds } from './digest-holds';
import { digestScriptOf } from './digest-script';

/**
 * The browser suite's Claude: bound over `ClaudeAgentService` in the API that suite starts,
 * so the prompt builder, the answer's guard, the owner match, and the worker all run for
 * real, and nothing starts a process, opens a socket, or reads a token.
 *
 * The API's own e2e specs use `FakeClaudeAgent`, which a spec configures by calling it. A
 * browser spec is in another process and cannot, so this one takes its orders from the
 * prompt instead — `digestScriptOf` says how — and its one piece of state, which keys are
 * being held, from `control-server.ts`.
 *
 * It keeps the promise of the real service a worker depends on: **a call whose signal fired
 * never resolves** — it rejects as `FAILED` with the signal's reason as its cause.
 */
export class ScriptedClaudeAgent {
  constructor(private readonly holds: DigestHolds) {}

  /** `ClaudeAgentService.runStructuredPrompt`, as far as its caller can tell. */
  async runStructuredPrompt(
    request: ClaudeStructuredPrompt,
    signal: AbortSignal,
  ): Promise<ClaudeStructuredReply> {
    const script = digestScriptOf(request.prompt);

    try {
      await this.holds.released(script.holdKeys, signal);
    } catch (cause) {
      throw new ClaudeAgentError(ClaudeAgentFailure.FAILED, `${CLAUDE_MARKER}: hung up`, {
        cause,
      });
    }

    if (script.fails) {
      // What a spec looks for on the page, to show the reason a user reads is never this.
      throw new ClaudeAgentError(ClaudeAgentFailure.FAILED, `${CLAUDE_MARKER}: overloaded_error`);
    }

    return {
      output: script.answer,
      model: FAKE_MODEL,
      costUsd: FAKE_COST_USD,
      inputTokens: 3_000,
      outputTokens: 300,
    };
  }

  /** Nothing in the API sends a plain prompt; a path that starts to has taken a wrong turn. */
  runPrompt(): never {
    throw new Error('The scripted Claude answers structured prompts only');
  }
}
