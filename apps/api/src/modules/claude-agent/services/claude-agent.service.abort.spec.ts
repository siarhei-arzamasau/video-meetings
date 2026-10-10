import { ConfigService } from '@nestjs/config';

import { ClaudeAgentFailure } from '../claude-agent.constants';
import {
  ANSWER,
  answering,
  AUTH_TOKEN,
  AUTH_TOKEN_VARIABLE,
  claudeAgentOver,
  deferred,
  queryOver,
  requestOf,
  STRUCTURED_PROMPT,
} from './claude-agent-process.fixture';
import type { ClaudeAgentQuery } from './claude-agent-sdk.loader';
import { ClaudeAgentService } from './claude-agent.service';

/**
 * A call that was hung up on never resolves — whenever the caller's signal fired: before the
 * call, while the SDK was loading, while the process was answering, or in the two seconds the
 * SDK gives a process to finish before it kills it. Each of those is a decision the service
 * makes itself, so each is held here against a scripted process; that the real process does
 * stop on its signal is `test/claude-agent.live-spec.ts`.
 */
describe('ClaudeAgentService, when a schema-bound prompt is called off', () => {
  const timeLimit = new Error('The time limit passed');

  beforeEach(() => {
    delete process.env[AUTH_TOKEN_VARIABLE];
  });

  it('starts nothing for a call that was already called off', async () => {
    const { claudeAgent, started } = claudeAgentOver(answering);

    await expect(
      claudeAgent.runStructuredPrompt(STRUCTURED_PROMPT, AbortSignal.abort(timeLimit)),
    ).rejects.toMatchObject({ failure: ClaudeAgentFailure.FAILED, cause: timeLimit });
    expect(started).not.toHaveBeenCalled();
  });

  it('starts no process for a call called off while the SDK was still loading', async () => {
    const loaded = deferred<ClaudeAgentQuery>();
    const { query, started } = queryOver(answering);
    const claudeAgent = new ClaudeAgentService(
      new ConfigService({ [AUTH_TOKEN_VARIABLE]: AUTH_TOKEN }),
      { loadQuery: () => loaded.promise },
    );
    const caller = new AbortController();

    const call = claudeAgent.runStructuredPrompt(STRUCTURED_PROMPT, caller.signal);
    caller.abort(timeLimit);
    loaded.resolve(query);

    await expect(call).rejects.toMatchObject({
      failure: ClaudeAgentFailure.FAILED,
      cause: timeLimit,
    });
    expect(started).not.toHaveBeenCalled();
  });

  it('hangs up on the process, passing on why', async () => {
    const answerBegun = deferred();
    const hungUp = new Error('Claude Code process aborted by user');
    const { claudeAgent, started } = claudeAgentOver(async function* ({ options }) {
      const processSignal = options.abortController?.signal;
      yield ANSWER;
      answerBegun.resolve();
      // The real process is killed on this signal, and its stream throws.
      await new Promise((resolve) => processSignal?.addEventListener('abort', resolve));
      throw hungUp;
    });
    const caller = new AbortController();

    const call = claudeAgent.runStructuredPrompt(STRUCTURED_PROMPT, caller.signal);
    await answerBegun.promise;
    caller.abort(timeLimit);

    await expect(call).rejects.toMatchObject({ failure: ClaudeAgentFailure.FAILED, cause: hungUp });
    expect(requestOf(started).options.abortController?.signal.reason).toBe(timeLimit);
  });

  it('discards an answer that arrives after it, and still says what the answer cost', async () => {
    // The SDK kills the process about two seconds after an abort, and an answer can land
    // inside those two seconds. Were it returned, whether a time limit ended in an answer
    // would depend on which side of the limit the last token fell.
    const answerBegun = deferred();
    const answerArrives = deferred();
    const { claudeAgent } = claudeAgentOver(async function* () {
      yield ANSWER;
      answerBegun.resolve();
      await answerArrives.promise;
      yield* answering();
    });
    const caller = new AbortController();
    const onSpend = jest.fn();

    const call = claudeAgent.runStructuredPrompt({ ...STRUCTURED_PROMPT, onSpend }, caller.signal);
    await answerBegun.promise;
    caller.abort(timeLimit);
    answerArrives.resolve();

    await expect(call).rejects.toMatchObject({
      failure: ClaudeAgentFailure.FAILED,
      cause: timeLimit,
      costUsd: 0.0042,
    });
    // Told as the result arrived, which is before the answer was found to be too late.
    expect(onSpend).toHaveBeenCalledWith({ costUsd: 0.0042, inputTokens: 2100, outputTokens: 12 });
  });

  it('stops listening to the signal once the call has ended', async () => {
    const { claudeAgent, started } = claudeAgentOver(answering);
    const caller = new AbortController();

    await claudeAgent.runStructuredPrompt(STRUCTURED_PROMPT, caller.signal);
    caller.abort(timeLimit);

    // A signal that outlives its call — a shutdown's, shared by every call — must not go on
    // aborting the controllers of calls that ended long ago.
    expect(requestOf(started).options.abortController?.signal.aborted).toBe(false);
  });
});
