import { ClaudeAgentFailure } from './claude-agent.constants';

/**
 * The one error `ClaudeAgentService` throws. Not an `HttpException`: the module has no route,
 * and what a failed prompt means to a client belongs to whichever feature asked for it.
 */
export class ClaudeAgentError extends Error {
  constructor(
    readonly failure: ClaudeAgentFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = ClaudeAgentError.name;
  }
}
