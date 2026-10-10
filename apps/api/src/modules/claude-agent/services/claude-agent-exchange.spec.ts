import { ClaudeAgentFailure } from '../claude-agent.constants';
import { readExchange } from './claude-agent-exchange';
import type { ObservedMessage } from './claude-agent-exchange';

const STARTED: ObservedMessage = { type: 'system' };
const FIRST_ANSWER: ObservedMessage = { type: 'assistant', message: { model: 'first-model' } };
const LAST_ANSWER: ObservedMessage = { type: 'assistant', message: { model: 'last-model' } };
const RESULT: ObservedMessage = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Hello.',
  total_cost_usd: 0.0019,
  terminal_reason: 'completed',
  usage: {
    input_tokens: 2,
    output_tokens: 151,
    cache_read_input_tokens: 1950,
    cache_creation_input_tokens: 40,
  },
};

const HUNG_UP = new Error('Claude Code process aborted by user');

function throwThatItWasHungUpOn(): void {
  throw HUNG_UP;
}

/** A Claude Code process that says `messages` and then ends as `ending` has it end. */
async function* processSaying(
  messages: ObservedMessage[],
  ending: () => void = () => undefined,
): AsyncGenerator<ObservedMessage> {
  yield* messages;
  ending();
}

describe('readExchange', () => {
  it('returns the result with the last answer before it', async () => {
    const exchange = await readExchange(
      processSaying([STARTED, FIRST_ANSWER, LAST_ANSWER, RESULT]),
    );

    expect(exchange).toEqual({ result: RESULT, answer: LAST_ANSWER });
  });

  it('returns a result that no answer came before, with no answer', async () => {
    await expect(readExchange(processSaying([STARTED, RESULT]))).resolves.toEqual({
      result: RESULT,
      answer: undefined,
    });
  });

  it('returns at the result, before whatever the process does after it', async () => {
    // After a result that reports an error the SDK throws as well. Reading on would turn an
    // outcome that names its failure and its cost into one that names neither.
    await expect(
      readExchange(processSaying([LAST_ANSWER, RESULT], throwThatItWasHungUpOn)),
    ).resolves.toMatchObject({ result: RESULT });
  });

  it('tells its observer of the result as it arrives, before whatever the process does after it', async () => {
    const onResult = jest.fn();

    await readExchange(processSaying([LAST_ANSWER, RESULT], throwThatItWasHungUpOn), onResult);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(RESULT);
  });

  it.each([
    ['stopped before its result', throwThatItWasHungUpOn],
    ['ended without a result', (): void => undefined],
  ])('tells its observer nothing of a process that %s', async (_case, ending) => {
    const onResult = jest.fn();

    await expect(
      readExchange(processSaying([STARTED, LAST_ANSWER], ending), onResult),
    ).rejects.toMatchObject({ failure: ClaudeAgentFailure.FAILED });
    expect(onResult).not.toHaveBeenCalled();
  });

  it('reports a process that stopped before its result, keeping why', async () => {
    await expect(
      readExchange(processSaying([STARTED, LAST_ANSWER], throwThatItWasHungUpOn)),
    ).rejects.toMatchObject({ failure: ClaudeAgentFailure.FAILED, cause: HUNG_UP });
  });

  it('reports a process that ended without a result', async () => {
    await expect(readExchange(processSaying([STARTED, LAST_ANSWER]))).rejects.toMatchObject({
      failure: ClaudeAgentFailure.FAILED,
      message: 'Claude Code ended without a result',
    });
  });
});
