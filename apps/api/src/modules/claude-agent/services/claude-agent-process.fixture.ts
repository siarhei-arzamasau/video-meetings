import { ConfigService } from '@nestjs/config';

import { ClaudeModel } from '../claude-agent.constants';
import type { ObservedMessage } from './claude-agent-exchange';
import type { ClaudeAgentQuery } from './claude-agent-sdk.loader';
import { ClaudeAgentService } from './claude-agent.service';
import type { ClaudeStructuredPrompt } from './claude-agent.service';

export const AUTH_TOKEN_VARIABLE = 'ANTHROPIC_AUTH_TOKEN';
export const AUTH_TOKEN = 'sk-ant-a-token-no-spec-ever-sends';

export const STRUCTURED_PROMPT: ClaudeStructuredPrompt = {
  model: ClaudeModel.SONNET,
  systemPrompt: 'Answer through the schema.',
  prompt: 'Say hello.',
  schema: { type: 'object', properties: { greeting: { type: 'string' } } },
};

export const ANSWER: ObservedMessage = {
  type: 'assistant',
  message: { model: 'claude-sonnet-5-5' },
};

export const RESULT: ObservedMessage = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '{"greeting":"Hello."}',
  structured_output: { greeting: 'Hello.' },
  total_cost_usd: 0.0042,
  terminal_reason: 'completed',
  usage: {
    input_tokens: 2100,
    output_tokens: 12,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

export type QueryRequest = Parameters<ClaudeAgentQuery>[0];
export type ScriptedProcess = (request: QueryRequest) => AsyncIterable<ObservedMessage>;

/** A Claude Code process that answers at once, and well. */
export async function* answering(): AsyncGenerator<ObservedMessage> {
  yield ANSWER;
  yield RESULT;
}

/** A promise a spec settles when it chooses to. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

/** A scripted process as the SDK's `query`, which is typed by messages no spec writes out. */
export function queryOver(process: ScriptedProcess): {
  query: ClaudeAgentQuery;
  started: jest.Mock<AsyncIterable<ObservedMessage>, [QueryRequest]>;
} {
  const started = jest.fn(process);

  return { query: started as unknown as ClaudeAgentQuery, started };
}

/**
 * `ClaudeAgentService` over a Claude Code process a spec scripts: `process` is what the
 * process says to the request that started it, and `started` records those requests. Where
 * `query` comes from is the one thing replaced — the service is the real one, with a token.
 */
export function claudeAgentOver(process: ScriptedProcess): {
  claudeAgent: ClaudeAgentService;
  started: jest.Mock<AsyncIterable<ObservedMessage>, [QueryRequest]>;
} {
  const { query, started } = queryOver(process);
  const config = new ConfigService({ [AUTH_TOKEN_VARIABLE]: AUTH_TOKEN });
  const claudeAgent = new ClaudeAgentService(config, { loadQuery: async () => query });

  return { claudeAgent, started };
}

/** What the process was started with, the one time a spec started it. */
export function requestOf(
  started: jest.Mock<AsyncIterable<ObservedMessage>, [QueryRequest]>,
): QueryRequest {
  const [call] = started.mock.calls;

  if (call === undefined) {
    throw new Error('Claude Code was never started');
  }

  return call[0];
}
