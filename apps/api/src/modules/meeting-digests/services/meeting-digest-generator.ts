import { Injectable } from '@nestjs/common';

import { ClaudeAgentFailure } from '../../claude-agent/claude-agent.constants';
import { ClaudeAgentError } from '../../claude-agent/claude-agent.error';
import {
  ClaudeAgentService,
  ClaudeStructuredReply,
} from '../../claude-agent/services/claude-agent.service';
import { MEETING_DIGEST_MODEL } from '../meeting-digest.constants';
import { MeetingDigestError, MeetingDigestFailure } from '../meeting-digest.error';
import {
  MEETING_DIGEST_ANSWER_SCHEMA,
  MeetingDigestAnswer,
  readMeetingDigestAnswer,
} from './meeting-digest-answer';
import { buildMeetingDigestPrompt, MEETING_DIGEST_INSTRUCTIONS } from './meeting-digest-prompt';

export interface GeneratedMeetingDigest {
  answer: MeetingDigestAnswer;
  /** The model that answered, as the API named it. */
  model: string;
  /** What the SDK reckons the generation cost. For the log, and for no response. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Transcripts in, a validated digest out: one request to Claude, and no state. It reads no
 * table and writes none, so everything about a digest that depends on a meeting — who may see
 * it, whose name an owner is, what a failure shows — belongs to whoever calls it.
 *
 * Three ways it ends without a digest, and a caller can tell them apart:
 * - `MeetingDigestError` `TRANSCRIPTS_TOO_LONG` — past the cap, with nothing sent, or refused
 *   by the model as too long;
 * - `MeetingDigestError` `INVALID_ANSWER` — Claude answered something that is not a digest;
 * - a `ClaudeAgentError`, untouched — everything else, an abort of `signal` included. Whether
 *   that abort was a time limit or a shutdown is the caller's to know: the signal is its own.
 */
@Injectable()
export class MeetingDigestGenerator {
  constructor(private readonly claudeAgent: ClaudeAgentService) {}

  async generate(
    transcripts: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<GeneratedMeetingDigest> {
    // Built first, and it throws past the cap: transcripts too long to send are never sent.
    const prompt = buildMeetingDigestPrompt(transcripts);
    const { output, model, costUsd, inputTokens, outputTokens } = await this.ask(prompt, signal);
    const reading = readMeetingDigestAnswer(output);

    if ('problem' in reading) {
      throw new MeetingDigestError(
        MeetingDigestFailure.INVALID_ANSWER,
        `Claude's answer is not a digest: ${reading.problem}`,
        { costUsd },
      );
    }

    return { answer: reading.answer, model, costUsd, inputTokens, outputTokens };
  }

  private async ask(prompt: string, signal: AbortSignal): Promise<ClaudeStructuredReply> {
    try {
      return await this.claudeAgent.runStructuredPrompt(
        {
          model: MEETING_DIGEST_MODEL,
          systemPrompt: MEETING_DIGEST_INSTRUCTIONS,
          prompt,
          schema: MEETING_DIGEST_ANSWER_SCHEMA,
        },
        signal,
      );
    } catch (error) {
      if (!(error instanceof ClaudeAgentError)) {
        throw error;
      }

      if (error.failure !== ClaudeAgentFailure.PROMPT_TOO_LONG) {
        throw error;
      }

      // The cap counts characters and the model reads tokens, so a script denser than the
      // cap was measured on can pass the one and be refused by the other.
      throw new MeetingDigestError(
        MeetingDigestFailure.TRANSCRIPTS_TOO_LONG,
        'The model refused the transcripts as too long to read',
        { cause: error, costUsd: error.costUsd },
      );
    }
  }
}
