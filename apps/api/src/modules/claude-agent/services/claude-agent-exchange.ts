import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { ClaudeAgentFailure } from '../claude-agent.constants';
import { ClaudeAgentError } from '../claude-agent.error';
import type { ClaudeAgentExchange, ObservedAnswer, ObservedResult } from './claude-agent-outcome';

/**
 * A message of the Claude Code process, as far as this module reads one: the assistant's
 * answers, the result, and the fact of anything else. The SDK's own messages are assignable
 * to it, and a spec can write one out by hand.
 */
export type ObservedMessage =
  | ({ type: 'assistant' } & ObservedAnswer)
  | ({ type: 'result' } & ObservedResult)
  | { type: Exclude<SDKMessage['type'], 'assistant' | 'result'> };

/**
 * Waits for how a Claude Code process ended: its result, and the last answer before it.
 *
 * Returns at the result rather than draining the stream: after a result that reports an
 * error the SDK also throws, and returning here closes the process before it does. An
 * abort arrives as a throw from the stream too, and is reported the same way.
 */
export async function readExchange(
  messages: AsyncIterable<ObservedMessage>,
): Promise<ClaudeAgentExchange> {
  let answer: ObservedAnswer | undefined;

  try {
    for await (const message of messages) {
      if (message.type === 'assistant') {
        answer = message;
      }

      if (message.type === 'result') {
        return { result: message, answer };
      }
    }
  } catch (cause) {
    throw new ClaudeAgentError(
      ClaudeAgentFailure.FAILED,
      'Claude Code stopped before it produced a result',
      { cause },
    );
  }

  throw new ClaudeAgentError(ClaudeAgentFailure.FAILED, 'Claude Code ended without a result');
}
