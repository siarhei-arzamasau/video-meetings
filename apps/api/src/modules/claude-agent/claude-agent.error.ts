import { ClaudeAgentFailure } from './claude-agent.constants';

export interface ClaudeAgentErrorOptions extends ErrorOptions {
  /**
   * What the SDK reckons the failed call cost, whenever it produced a result to say so. A
   * refused token and a prompt that never left cost nothing; an answer that could not be used
   * was paid for all the same, and whoever logs the failure logs that too.
   */
  costUsd?: number;
}

/**
 * The one error `ClaudeAgentService` throws. Not an `HttpException`: the module has no route,
 * and what a failed prompt means to a client belongs to whichever feature asked for it.
 *
 * **The message is for a log, never for a user**: it quotes what the SDK and Anthropic said.
 */
export class ClaudeAgentError extends Error {
  /** Absent when no result reported one — the process never started, or was hung up on. */
  readonly costUsd?: number;

  constructor(
    readonly failure: ClaudeAgentFailure,
    message: string,
    options?: ClaudeAgentErrorOptions,
  ) {
    super(message, options);
    this.name = ClaudeAgentError.name;
    this.costUsd = options?.costUsd;
  }
}
