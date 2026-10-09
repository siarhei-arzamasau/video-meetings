import type { ConfigService } from '@nestjs/config';

import { ClaudeAgentFailure } from '../../claude-agent/claude-agent.constants';
import { ClaudeAgentError } from '../../claude-agent/claude-agent.error';
import type {
  ClaudeAgentService,
  ClaudeStructuredReply,
} from '../../claude-agent/services/claude-agent.service';
import {
  MAX_DIGEST_TRANSCRIPT_CHARACTERS,
  MEETING_DIGEST_MODEL,
} from '../meeting-digest.constants';
import type { MeetingHooks } from '../../meeting-tools/meeting-hooks';
import type { MeetingTools } from '../../meeting-tools/meeting-tools';
import { MeetingDigestError, MeetingDigestFailure } from '../meeting-digest.error';
import { MEETING_DIGEST_ANSWER_SCHEMA } from './meeting-digest-answer';
import { MeetingDigestGenerator } from './meeting-digest-generator';
import { buildMeetingDigestInstructions, buildMeetingDigestPrompt } from './meeting-digest-prompt';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';

const TRANSCRIPTS = ['We moved the launch to April.', 'Alice will rewrite the emails.'];

const ANSWER = {
  summary: 'The launch moved to April.',
  actionItems: [{ description: 'Rewrite the emails.', owner: 'Alice' }],
  decisions: [{ description: 'The launch moves to April.' }],
};

/** Hooks as `MeetingHooks` answers with them, down to their being the ones handed on. */
const HOOKS = { PreToolUse: [] };

function replyWith(output: unknown): ClaudeStructuredReply {
  return {
    output,
    model: 'claude-sonnet-5-5',
    costUsd: 0.0042,
    inputTokens: 2100,
    outputTokens: 90,
  };
}

describe('MeetingDigestGenerator', () => {
  const runStructuredPrompt = jest.fn<
    ReturnType<ClaudeAgentService['runStructuredPrompt']>,
    Parameters<ClaudeAgentService['runStructuredPrompt']>
  >();
  const createServer = jest.fn();
  const createHooks = jest.fn();
  /** What the environment sets; a variable it leaves out answers with the default asked for. */
  const settings = new Map<string, number>();
  const config = {
    get: (name: string, fallback: number): number => settings.get(name) ?? fallback,
  };
  const generator = new MeetingDigestGenerator(
    { runStructuredPrompt } as unknown as ClaudeAgentService,
    { createServer } as unknown as MeetingTools,
    { createHooks } as unknown as MeetingHooks,
    config as unknown as ConfigService,
  );
  const signal = new AbortController().signal;

  beforeEach(() => {
    runStructuredPrompt.mockReset();
    createServer.mockReset().mockResolvedValue({ type: 'sdk', name: 'meeting' });
    createHooks.mockReset().mockReturnValue(HOOKS);
    settings.clear();
  });

  it('asks Claude once, with the instructions, the schema, and the transcripts as the prompt', async () => {
    runStructuredPrompt.mockResolvedValue(replyWith(ANSWER));

    await generator.generate(MEETING_ID, TRANSCRIPTS, signal);

    expect(runStructuredPrompt).toHaveBeenCalledTimes(1);
    expect(runStructuredPrompt).toHaveBeenCalledWith(
      {
        model: MEETING_DIGEST_MODEL,
        systemPrompt: buildMeetingDigestInstructions(MEETING_ID, 20),
        prompt: buildMeetingDigestPrompt(TRANSCRIPTS),
        schema: MEETING_DIGEST_ANSWER_SCHEMA,
        tools: {
          createServer: expect.any(Function),
          toolNames: ['find_tasks', 'upsert_task', 'update_meeting'],
          createHooks: expect.any(Function),
          maxTurns: 25,
        },
      },
      signal,
    );
  });

  it("hands the run the meeting's own tools, made only when the run asks for them", async () => {
    runStructuredPrompt.mockResolvedValue(replyWith(ANSWER));

    await generator.generate(MEETING_ID, TRANSCRIPTS, signal);

    // Making a server loads the SDK, which the service does and a stand-in for it never has to.
    expect(createServer).not.toHaveBeenCalled();

    const [request] = runStructuredPrompt.mock.calls[0] ?? [];
    await expect(request?.tools?.createServer()).resolves.toEqual({ type: 'sdk', name: 'meeting' });
    expect(createServer).toHaveBeenCalledWith(MEETING_ID);
  });

  it('hands the run hooks made for it, with the default budget and turns past it to answer in', async () => {
    runStructuredPrompt.mockResolvedValue(replyWith(ANSWER));

    await generator.generate(MEETING_ID, TRANSCRIPTS, signal);

    // The budget counts, so hooks are made by whoever starts a process, one set a process.
    expect(createHooks).not.toHaveBeenCalled();

    const [request] = runStructuredPrompt.mock.calls[0] ?? [];
    expect(request?.tools?.createHooks?.()).toBe(HOOKS);
    expect(createHooks).toHaveBeenCalledWith(20);
    expect(request?.tools?.maxTurns).toBe(25);
  });

  it('takes the budget from MEETING_DIGEST_MAX_TOOL_CALLS, read for each generation', async () => {
    runStructuredPrompt.mockResolvedValue(replyWith(ANSWER));
    settings.set('MEETING_DIGEST_MAX_TOOL_CALLS', 3);

    await generator.generate(MEETING_ID, TRANSCRIPTS, signal);

    const [request] = runStructuredPrompt.mock.calls[0] ?? [];
    request?.tools?.createHooks?.();
    expect(createHooks).toHaveBeenCalledWith(3);
    // The model is told the number its hooks enforce, and no other.
    expect(request?.systemPrompt).toBe(buildMeetingDigestInstructions(MEETING_ID, 3));
    // Past the budget, or a run calling one tool a turn would end on the cap, a failure,
    // before a hook ever refused it a call.
    expect(request?.tools?.maxTurns).toBe(8);
  });

  it('returns the validated digest with what the call cost', async () => {
    runStructuredPrompt.mockResolvedValue(replyWith(ANSWER));

    await expect(generator.generate(MEETING_ID, TRANSCRIPTS, signal)).resolves.toEqual({
      answer: {
        summary: 'The launch moved to April.',
        actionItems: [{ description: 'Rewrite the emails.', ownerName: 'Alice' }],
        decisions: [{ description: 'The launch moves to April.' }],
      },
      model: 'claude-sonnet-5-5',
      costUsd: 0.0042,
      inputTokens: 2100,
      outputTokens: 90,
    });
  });

  it('asks Claude about recordings in which nothing was heard, as about any others', async () => {
    // One behaviour for a caller to rely on: silence is a meeting the instructions cover,
    // not a case this code answers for itself.
    runStructuredPrompt.mockResolvedValue(
      replyWith({
        summary: 'The recordings contain no speech.',
        actionItems: [],
        decisions: [],
      }),
    );

    await expect(generator.generate(MEETING_ID, ['', '  '], signal)).resolves.toMatchObject({
      answer: { summary: 'The recordings contain no speech.', actionItems: [], decisions: [] },
    });
    expect(runStructuredPrompt).toHaveBeenCalledTimes(1);
  });

  it('refuses to ask Claude about no transcript at all', async () => {
    await expect(generator.generate(MEETING_ID, [], signal)).rejects.toThrow(
      'at least one transcript',
    );
    expect(runStructuredPrompt).not.toHaveBeenCalled();
  });

  it('sends nothing when the transcripts are past the cap', async () => {
    const tooLong = ['a'.repeat(MAX_DIGEST_TRANSCRIPT_CHARACTERS), 'b'];

    await expect(generator.generate(MEETING_ID, tooLong, signal)).rejects.toMatchObject({
      failure: MeetingDigestFailure.TRANSCRIPTS_TOO_LONG,
    });
    expect(runStructuredPrompt).not.toHaveBeenCalled();
  });

  it('reports a provider that found the prompt too long as the same failure', async () => {
    // The cap counts characters and the model reads tokens, so a dense script can pass the
    // one and not the other. Whoever shows the failure has one reason to show either way.
    const refused = new ClaudeAgentError(ClaudeAgentFailure.PROMPT_TOO_LONG, 'Prompt is too long', {
      costUsd: 0,
    });
    runStructuredPrompt.mockRejectedValue(refused);

    await expect(generator.generate(MEETING_ID, TRANSCRIPTS, signal)).rejects.toMatchObject({
      failure: MeetingDigestFailure.TRANSCRIPTS_TOO_LONG,
      costUsd: 0,
      cause: refused,
    });
  });

  it('refuses an answer that is not a digest, and says what the call cost all the same', async () => {
    runStructuredPrompt.mockResolvedValue(replyWith({ ...ANSWER, summary: '' }));

    const failure = generator.generate(MEETING_ID, TRANSCRIPTS, signal);

    await expect(failure).rejects.toBeInstanceOf(MeetingDigestError);
    await expect(failure).rejects.toMatchObject({
      failure: MeetingDigestFailure.INVALID_ANSWER,
      costUsd: 0.0042,
    });
  });

  it.each([
    ClaudeAgentFailure.AUTHENTICATION,
    ClaudeAgentFailure.NOT_CONFIGURED,
    ClaudeAgentFailure.FAILED,
  ])('lets a %s failure through as Claude reported it', async (failure) => {
    const reported = new ClaudeAgentError(failure, 'what the SDK said');
    runStructuredPrompt.mockRejectedValue(reported);

    await expect(generator.generate(MEETING_ID, TRANSCRIPTS, signal)).rejects.toBe(reported);
  });
});
