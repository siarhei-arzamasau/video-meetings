import type {
  SDKAssistantMessageError,
  SDKResultError,
  TerminalReason,
} from '@anthropic-ai/claude-agent-sdk';

import { ClaudeAgentFailure } from '../claude-agent.constants';
import { ClaudeAgentError } from '../claude-agent.error';

/**
 * What this module reads of the SDK's messages, and nothing more. The SDK's own types are
 * assignable to these, so the mapping below is a function of a few fields a spec can write
 * out by hand — where the full messages run to dozens it never looks at.
 */
interface ObservedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

interface ObservedResultFields {
  is_error: boolean;
  total_cost_usd: number;
  terminal_reason?: TerminalReason;
}

export type ObservedResult =
  | (ObservedResultFields & {
      subtype: 'success';
      result: string;
      structured_output?: unknown;
      usage: ObservedUsage;
    })
  | (ObservedResultFields & { subtype: SDKResultError['subtype']; errors: string[] });

/** The last assistant message: it names the model, and carries the API's error if any. */
export interface ObservedAnswer {
  error?: SDKAssistantMessageError;
  message: { model: string };
}

export interface ClaudeAgentExchange {
  result: ObservedResult;
  answer: ObservedAnswer | undefined;
}

export interface ClaudeAgentAnswer {
  text: string;
  /** Present only when the call bound the answer to a schema and the model answered through it. */
  structuredOutput: unknown;
  /** The model that answered, as the API named it — not merely the one asked for. */
  model: string;
  /** What the SDK reckons the call cost. An estimate, not a billing statement. */
  costUsd: number;
  /** Everything the model read: what was billed in full, written to the cache, and read from it. */
  inputTokens: number;
  outputTokens: number;
}

/** How the SDK marks an assistant message that is really the API refusing the credential. */
const REFUSED_CREDENTIAL: SDKAssistantMessageError = 'authentication_failed';

/**
 * How a result says the prompt was more than the model can read. `blocking_limit` is Claude
 * Code declining to send it at all — what a prompt of 5.4 million characters got on
 * 2026-10-08, in 30 ms and at no cost — and `prompt_too_long` is the API saying so itself.
 * Read from the reason, never from the text beside it, which is the SDK's to reword.
 */
const TOO_LONG_REASONS: ReadonlySet<TerminalReason> = new Set([
  'blocking_limit',
  'prompt_too_long',
]);

/**
 * What one exchange with Claude Code came to: an answer, or the error to throw for it. Pure,
 * so every shape the SDK is known to produce is a row in the spec beside this file rather
 * than a request someone has to pay for.
 */
export function outcomeOf({
  result,
  answer,
}: ClaudeAgentExchange): ClaudeAgentAnswer | ClaudeAgentError {
  if (result.subtype !== 'success' || result.is_error || answer === undefined) {
    return failureOf(result, answer);
  }

  const { usage } = result;

  return {
    text: result.result,
    structuredOutput: result.structured_output,
    model: answer.message.model,
    costUsd: result.total_cost_usd,
    inputTokens:
      usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
    outputTokens: usage.output_tokens,
  };
}

/**
 * The same, for a call that bound its answer to a schema. An answer without a structured
 * output is a failure here even though the turn ended well: the model replied in prose, and
 * prose is not parsed in the hope that it holds the object that was asked for.
 */
export function structuredOutcomeOf(
  exchange: ClaudeAgentExchange,
): ClaudeAgentAnswer | ClaudeAgentError {
  const outcome = outcomeOf(exchange);

  if (outcome instanceof ClaudeAgentError || outcome.structuredOutput !== undefined) {
    return outcome;
  }

  return new ClaudeAgentError(
    ClaudeAgentFailure.FAILED,
    'Claude answered without the structured output it was asked for',
    { costUsd: outcome.costUsd },
  );
}

function failureOf(result: ObservedResult, answer: ObservedAnswer | undefined): ClaudeAgentError {
  // An API error still arrives as a `success` result, its text being the error; `errors`
  // is only there when the turn itself could not finish.
  const said = result.subtype === 'success' ? result.result : result.errors.join('; ');
  const detail = `${said} (${result.subtype}, ${result.terminal_reason ?? 'no terminal reason'})`;
  const options = { costUsd: result.total_cost_usd };

  if (answer?.error === REFUSED_CREDENTIAL) {
    return new ClaudeAgentError(
      ClaudeAgentFailure.AUTHENTICATION,
      `Anthropic refused ANTHROPIC_AUTH_TOKEN: ${detail}`,
      options,
    );
  }

  if (result.terminal_reason !== undefined && TOO_LONG_REASONS.has(result.terminal_reason)) {
    return new ClaudeAgentError(
      ClaudeAgentFailure.PROMPT_TOO_LONG,
      `The prompt is longer than the model can read: ${detail}`,
      options,
    );
  }

  return new ClaudeAgentError(
    ClaudeAgentFailure.FAILED,
    `Claude did not answer: ${detail}`,
    options,
  );
}
