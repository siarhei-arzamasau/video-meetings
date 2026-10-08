/** The models this module asks for, under the ids Anthropic's API knows them by. */
export enum ClaudeModel {
  SONNET = 'claude-sonnet-5-5',
}

/** Why a prompt got no answer — what a caller branches on, where the message is for a log. */
export enum ClaudeAgentFailure {
  /** There is no token to authenticate with, so nothing was sent. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** Anthropic refused the configured token. */
  AUTHENTICATION = 'AUTHENTICATION',
  /** Anything else: the process would not start, the API errored, the turn was cut short. */
  FAILED = 'FAILED',
}
