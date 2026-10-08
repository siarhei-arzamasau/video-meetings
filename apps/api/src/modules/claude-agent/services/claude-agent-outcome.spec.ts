import { ClaudeAgentFailure } from '../claude-agent.constants';
import { ClaudeAgentError } from '../claude-agent.error';
import { outcomeOf, structuredOutcomeOf } from './claude-agent-outcome';
import type { ObservedAnswer, ObservedResult } from './claude-agent-outcome';

const USAGE = {
  input_tokens: 2,
  output_tokens: 151,
  cache_read_input_tokens: 1950,
  cache_creation_input_tokens: 40,
};

const SONNET_ANSWER: ObservedAnswer = { message: { model: 'claude-sonnet-5-5' } };

/** A turn that ended well, as the SDK reports one. */
function answered(overrides: Partial<ObservedResult> = {}): ObservedResult {
  return {
    subtype: 'success',
    is_error: false,
    result: 'Hello.',
    total_cost_usd: 0.0019,
    terminal_reason: 'completed',
    usage: USAGE,
    ...overrides,
  } as ObservedResult;
}

/**
 * Two of the shapes below were seen against the real API on 2026-10-08 and are cut down to
 * what `outcomeOf` reads: the good result, and the prompt Claude Code would not send. Of the
 * refused token, the live spec confirms the one field that decides it — the assistant
 * message's `error`. The rest are written from the SDK's types, no run having produced them;
 * when one does, correct its row from what the run showed.
 */
describe('outcomeOf', () => {
  it('reads the text, the model that answered, the cost, and the tokens off a good result', () => {
    expect(outcomeOf({ result: answered(), answer: SONNET_ANSWER })).toEqual({
      text: 'Hello.',
      structuredOutput: undefined,
      model: 'claude-sonnet-5-5',
      costUsd: 0.0019,
      // Everything the model read, cached or not: a prompt's size is all three together.
      inputTokens: 1992,
      outputTokens: 151,
    });
  });

  it.each<[string, ObservedResult, ObservedAnswer | undefined, ClaudeAgentFailure, number]>([
    [
      'a refused token, which arrives as a successful result whose text is the error',
      answered({ is_error: true, result: 'Invalid bearer token', total_cost_usd: 0 }),
      { error: 'authentication_failed', message: { model: '<synthetic>' } },
      ClaudeAgentFailure.AUTHENTICATION,
      0,
    ],
    [
      'a prompt Claude Code would not send, being past the context window',
      answered({
        is_error: true,
        result: 'Prompt is too long',
        total_cost_usd: 0,
        terminal_reason: 'blocking_limit',
      }),
      { error: 'invalid_request', message: { model: '<synthetic>' } },
      ClaudeAgentFailure.PROMPT_TOO_LONG,
      0,
    ],
    [
      // Claude Code's own check answered first for the one size tried, so this is the type's word.
      'a prompt the API itself turned away as too long',
      answered({
        is_error: true,
        result: 'Prompt is too long',
        total_cost_usd: 0,
        terminal_reason: 'prompt_too_long',
      }),
      { error: 'invalid_request', message: { model: '<synthetic>' } },
      ClaudeAgentFailure.PROMPT_TOO_LONG,
      0,
    ],
    [
      'an API error, which is paid for when the request got as far as a model',
      answered({ is_error: true, result: 'API Error: 529 Overloaded', total_cost_usd: 0.004 }),
      { error: 'overloaded', message: { model: '<synthetic>' } },
      ClaudeAgentFailure.FAILED,
      0.004,
    ],
    [
      'a turn cut short at the turn cap',
      {
        subtype: 'error_max_turns',
        is_error: true,
        errors: ['Reached maximum number of turns (1)'],
        total_cost_usd: 0.0031,
        terminal_reason: 'max_turns',
      },
      SONNET_ANSWER,
      ClaudeAgentFailure.FAILED,
      0.0031,
    ],
    [
      'an answer that never fitted the schema it was bound to',
      {
        subtype: 'error_max_structured_output_retries',
        is_error: true,
        errors: ['Failed to provide valid structured output'],
        total_cost_usd: 0.012,
        terminal_reason: 'structured_output_retry_exhausted',
      },
      SONNET_ANSWER,
      ClaudeAgentFailure.FAILED,
      0.012,
    ],
    [
      'a result with no assistant message before it, so no model to name',
      answered(),
      undefined,
      ClaudeAgentFailure.FAILED,
      0.0019,
    ],
  ])('reports %s', (_case, result, answer, failure, costUsd) => {
    const outcome = outcomeOf({ result, answer });

    expect(outcome).toBeInstanceOf(ClaudeAgentError);
    expect(outcome).toMatchObject({ failure, costUsd });
  });

  it('keeps what the SDK said in the message, for the log', () => {
    const outcome = outcomeOf({
      result: {
        subtype: 'error_max_turns',
        is_error: true,
        errors: ['Reached maximum number of turns (1)', 'second line'],
        total_cost_usd: 0,
        terminal_reason: 'max_turns',
      },
      answer: SONNET_ANSWER,
    });

    expect(outcome).toMatchObject({
      message: expect.stringContaining('Reached maximum number of turns (1); second line'),
    });
  });
});

describe('structuredOutcomeOf', () => {
  const DIGEST = { summary: 'They moved the launch.' };

  it('hands back the structured output, not the text that repeats it', () => {
    const outcome = structuredOutcomeOf({
      result: answered({ result: JSON.stringify(DIGEST), structured_output: DIGEST }),
      answer: SONNET_ANSWER,
    });

    expect(outcome).toMatchObject({ structuredOutput: DIGEST, model: 'claude-sonnet-5-5' });
  });

  it('reports an answer in prose as a failure that was paid for', () => {
    // A model that replies in words instead of through the schema has not answered the
    // question that was asked, and its text must not be parsed in the hope that it did.
    const outcome = structuredOutcomeOf({
      result: answered({ result: '{"summary":"They moved the launch."}' }),
      answer: SONNET_ANSWER,
    });

    expect(outcome).toBeInstanceOf(ClaudeAgentError);
    expect(outcome).toMatchObject({ failure: ClaudeAgentFailure.FAILED, costUsd: 0.0019 });
  });

  it('passes a failure through as it is', () => {
    const outcome = structuredOutcomeOf({
      result: answered({ is_error: true, terminal_reason: 'blocking_limit', total_cost_usd: 0 }),
      answer: undefined,
    });

    expect(outcome).toMatchObject({ failure: ClaudeAgentFailure.PROMPT_TOO_LONG });
  });
});
