import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DEFAULT_MEETING_DIGEST_MAX_TOOL_CALLS } from '../../../config/meeting-digest.defaults';
import { ClaudeAgentFailure } from '../../claude-agent/claude-agent.constants';
import { ClaudeAgentError } from '../../claude-agent/claude-agent.error';
import type { ClaudeAgentSpend } from '../../claude-agent/services/claude-agent-outcome';
import { turnsForToolCalls } from '../../claude-agent/services/claude-agent-tools';
import type { ClaudeAgentTools } from '../../claude-agent/services/claude-agent-tools';
import {
  ClaudeAgentService,
  ClaudeStructuredReply,
} from '../../claude-agent/services/claude-agent.service';
import { MeetingHooks } from '../../meeting-tools/meeting-hooks';
import { MeetingToolName, MeetingTools } from '../../meeting-tools/meeting-tools';
import { MEETING_DIGEST_MODEL } from '../meeting-digest.constants';
import { MeetingDigestError, MeetingDigestFailure } from '../meeting-digest.error';
import {
  MEETING_DIGEST_ANSWER_SCHEMA,
  MeetingDigestAnswer,
  readMeetingDigestAnswer,
} from './meeting-digest-answer';
import { buildMeetingDigestInstructions, buildMeetingDigestPrompt } from './meeting-digest-prompt';

export interface GeneratedMeetingDigest {
  answer: MeetingDigestAnswer;
  /** The model that answered, as the API named it. */
  model: string;
  /** What the SDK reckons the generation cost. For whoever measures one, and for no response. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** A cost as the SDK reported it, to the hundredth of a cent a short generation is priced in. */
const usd = (costUsd: number): string => `$${costUsd.toFixed(4)}`;

/**
 * Transcripts in, a validated digest out: one run of Claude. It reads no table and writes
 * none itself, so everything about a digest that depends on a meeting — who may see it,
 * whose name an owner is, what a failure shows — belongs to whoever calls it.
 *
 * **The run is handed the meeting's tools, and those do write**: `MeetingTools`' server,
 * made for this meeting, all three of its tools allowed. The model keeps the meeting's
 * tasks through them while it writes the digest, so a generation leaves tasks behind
 * whether or not its answer is kept — one that fails, is hung up on, or is discarded for a
 * recording deleted meanwhile has still written what it wrote. The answer itself comes
 * back bound to the schema as before, and is stored by the caller and nobody else.
 *
 * **And `MeetingHooks`' hooks, which bound what it does with them**: a task's title too
 * short to be one is refused, every call past `MEETING_DIGEST_MAX_TOOL_CALLS` is refused,
 * and each call that ran is logged. A refusal is the model's to read and the run goes on,
 * so a generation that runs out of calls still answers with its digest. The instructions
 * carry the same number, so the model plans for it rather than meets it.
 *
 * **What a run cost is logged here, against its meeting, when its result arrives** — the
 * one line that keeps a cost, and the log is the only place one is kept. Before the answer
 * is read, so that an answer that is not a digest, one that arrived after the call was hung
 * up on, and one the caller goes on to discard have each been logged: all were paid for.
 * A run that never reached a result reported no cost, and leaves no such line.
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
  private readonly logger = new Logger(MeetingDigestGenerator.name);

  constructor(
    private readonly claudeAgent: ClaudeAgentService,
    private readonly tools: MeetingTools,
    private readonly hooks: MeetingHooks,
    private readonly config: ConfigService,
  ) {}

  async generate(
    meetingId: string,
    transcripts: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<GeneratedMeetingDigest> {
    // Built first, and it throws past the cap: transcripts too long to send are never sent.
    const prompt = buildMeetingDigestPrompt(transcripts);
    const reply = await this.ask(meetingId, prompt, signal);
    const { output, model, costUsd, inputTokens, outputTokens } = reply;
    const reading = readMeetingDigestAnswer(output);

    if ('problem' in reading) {
      throw new MeetingDigestError(
        MeetingDigestFailure.INVALID_ANSWER,
        `Claude's answer is not a digest: ${reading.problem}`,
      );
    }

    return { answer: reading.answer, model, costUsd, inputTokens, outputTokens };
  }

  /** The meeting's tools, and the hooks that hold one run to `maxToolCalls` of them. */
  private toolsFor(meetingId: string, maxToolCalls: number): ClaudeAgentTools {
    return {
      createServer: () => this.tools.createServer(meetingId),
      toolNames: Object.values(MeetingToolName),
      createHooks: () => this.hooks.createHooks(maxToolCalls),
      maxTurns: turnsForToolCalls(maxToolCalls),
    };
  }

  private logSpend(
    meetingId: string,
    { costUsd, inputTokens, outputTokens }: ClaudeAgentSpend,
  ): void {
    this.logger.log(
      `Digest of meeting ${meetingId}: a run of Claude cost ${usd(costUsd)}, ${String(inputTokens)} tokens in and ${String(outputTokens)} out`,
    );
  }

  private async ask(
    meetingId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<ClaudeStructuredReply> {
    // Read per generation, as the worker reads its time limit, so a spec can change it.
    // One number for what the model is told and what its hooks enforce.
    const maxToolCalls = this.config.get<number>(
      'MEETING_DIGEST_MAX_TOOL_CALLS',
      DEFAULT_MEETING_DIGEST_MAX_TOOL_CALLS,
    );

    try {
      return await this.claudeAgent.runStructuredPrompt(
        {
          model: MEETING_DIGEST_MODEL,
          systemPrompt: buildMeetingDigestInstructions(meetingId, maxToolCalls),
          prompt,
          schema: MEETING_DIGEST_ANSWER_SCHEMA,
          tools: this.toolsFor(meetingId, maxToolCalls),
          onSpend: (spend) => this.logSpend(meetingId, spend),
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
        { cause: error },
      );
    }
  }
}
