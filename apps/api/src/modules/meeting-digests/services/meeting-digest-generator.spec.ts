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
import { MeetingDigestError, MeetingDigestFailure } from '../meeting-digest.error';
import { MEETING_DIGEST_ANSWER_SCHEMA } from './meeting-digest-answer';
import { MeetingDigestGenerator } from './meeting-digest-generator';
import { buildMeetingDigestPrompt, MEETING_DIGEST_INSTRUCTIONS } from './meeting-digest-prompt';

const TRANSCRIPTS = ['We moved the launch to April.', 'Alice will rewrite the emails.'];

const ANSWER = {
  summary: 'The launch moved to April.',
  actionItems: [{ description: 'Rewrite the emails.', owner: 'Alice' }],
  decisions: [{ description: 'The launch moves to April.' }],
};

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
  const generator = new MeetingDigestGenerator({
    runStructuredPrompt,
  } as unknown as ClaudeAgentService);
  const signal = new AbortController().signal;

  beforeEach(() => {
    runStructuredPrompt.mockReset();
  });

  it('asks Claude once, with the instructions, the schema, and the transcripts as the prompt', async () => {
    runStructuredPrompt.mockResolvedValue(replyWith(ANSWER));

    await generator.generate(TRANSCRIPTS, signal);

    expect(runStructuredPrompt).toHaveBeenCalledTimes(1);
    expect(runStructuredPrompt).toHaveBeenCalledWith(
      {
        model: MEETING_DIGEST_MODEL,
        systemPrompt: MEETING_DIGEST_INSTRUCTIONS,
        prompt: buildMeetingDigestPrompt(TRANSCRIPTS),
        schema: MEETING_DIGEST_ANSWER_SCHEMA,
      },
      signal,
    );
  });

  it('returns the validated digest with what the call cost', async () => {
    runStructuredPrompt.mockResolvedValue(replyWith(ANSWER));

    await expect(generator.generate(TRANSCRIPTS, signal)).resolves.toEqual({
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

    await expect(generator.generate(['', '  '], signal)).resolves.toMatchObject({
      answer: { summary: 'The recordings contain no speech.', actionItems: [], decisions: [] },
    });
    expect(runStructuredPrompt).toHaveBeenCalledTimes(1);
  });

  it('refuses to ask Claude about no transcript at all', async () => {
    await expect(generator.generate([], signal)).rejects.toThrow('at least one transcript');
    expect(runStructuredPrompt).not.toHaveBeenCalled();
  });

  it('sends nothing when the transcripts are past the cap', async () => {
    const tooLong = ['a'.repeat(MAX_DIGEST_TRANSCRIPT_CHARACTERS), 'b'];

    await expect(generator.generate(tooLong, signal)).rejects.toMatchObject({
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

    await expect(generator.generate(TRANSCRIPTS, signal)).rejects.toMatchObject({
      failure: MeetingDigestFailure.TRANSCRIPTS_TOO_LONG,
      costUsd: 0,
      cause: refused,
    });
  });

  it('refuses an answer that is not a digest, and says what the call cost all the same', async () => {
    runStructuredPrompt.mockResolvedValue(replyWith({ ...ANSWER, summary: '' }));

    const failure = generator.generate(TRANSCRIPTS, signal);

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

    await expect(generator.generate(TRANSCRIPTS, signal)).rejects.toBe(reported);
  });
});
