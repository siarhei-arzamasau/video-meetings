import { ClaudeAgentFailure } from '../../src/modules/claude-agent/claude-agent.constants';
import { ClaudeAgentError } from '../../src/modules/claude-agent/claude-agent.error';
import { ClaudeAgentService } from '../../src/modules/claude-agent/services/claude-agent.service';
import type {
  ClaudeStructuredPrompt,
  ClaudeStructuredReply,
} from '../../src/modules/claude-agent/services/claude-agent.service';

/** What the fake does with a prompt once it has been handed one. */
export type ClaudeReply =
  | { kind: 'answer'; output: unknown }
  | { kind: 'error'; error: Error }
  /** No answer until `release()` — or until the caller hangs up, which is counted. */
  | { kind: 'hold' };

/** The model the fake says answered, and what it says each call cost: both recognisable. */
export const FAKE_MODEL = 'claude-fake-e2e';
export const FAKE_COST_USD = 0.004217;

/**
 * Words only "Anthropic" says. Whatever the API stores or serves about a failed digest must
 * not contain them: the reason a user reads is the API's own fixed copy.
 */
export const CLAUDE_MARKER = 'anthropic-internal-marker-9c1e';

const RECORDING = /<recording number="(\d+)">\n([\s\S]*?)\n<\/recording>/g;

/** What each recording of a prompt held, in the order the prompt gave them. */
export function recordingsIn(prompt: string): string[] {
  return [...prompt.matchAll(RECORDING)].map((match) => match[2] ?? '');
}

/**
 * A digest any spec can check against what was sent: one decision per recording, quoting
 * its transcript, and one unowned action item per recording. So "the digest holds all three"
 * is an assertion about three decisions, not about how a model worded a summary.
 */
export function digestOf(prompt: string): unknown {
  const recordings = recordingsIn(prompt);

  return {
    summary: `A digest of ${String(recordings.length)} recording(s).`,
    actionItems: recordings.map((_text, index) => ({
      description: `Follow up on recording ${String(index + 1)}.`,
      owner: null,
    })),
    decisions: recordings.map((text) => ({ description: text })),
  };
}

interface HeldCall {
  request: ClaudeStructuredPrompt;
  resolve: (reply: ClaudeStructuredReply) => void;
}

/**
 * The tests' Claude: bound over `ClaudeAgentService` itself, so the prompt builder, the
 * answer's guard, and the worker all run for real, and `calls` holds the exact text that
 * would have left for Anthropic. Nothing here starts a process or opens a socket, which is
 * what makes "no call was made" an assertion and lets the suite run with no token.
 *
 * It keeps the one promise of the real service a worker depends on: **a call whose signal
 * fired never resolves** — it rejects as `FAILED` with the signal's reason as its cause.
 * The real rejection trails the abort by about two seconds; this one does not.
 */
export class FakeClaudeAgent {
  /** Every prompt handed over, in order. */
  calls: ClaudeStructuredPrompt[] = [];
  /** Calls the caller hung up on before any answer. */
  hangUps = 0;
  /** The most calls that were ever open at once: 1, if no meeting had two generations. */
  mostOpen = 0;
  /** Decides each reply. Reset to `digestOf` the prompt by `reset()`. */
  reply: (request: ClaudeStructuredPrompt) => ClaudeReply = answerWithDigest;

  private open = 0;
  private readonly held = new Set<HeldCall>();
  private waiters: Array<() => void> = [];

  /** What `createTestApp` needs to bind this over the real service. */
  override(): { token: unknown; value: unknown } {
    return { token: ClaudeAgentService, value: this };
  }

  reset(): void {
    this.release();
    this.calls = [];
    this.hangUps = 0;
    this.mostOpen = 0;
    this.reply = answerWithDigest;
  }

  /** `ClaudeAgentService.runStructuredPrompt`, as far as its caller can tell. */
  async runStructuredPrompt(
    request: ClaudeStructuredPrompt,
    signal: AbortSignal,
  ): Promise<ClaudeStructuredReply> {
    if (signal.aborted) {
      throw hungUpOn(signal);
    }

    const reply = this.reply(request);

    this.calls.push(request);
    this.open += 1;
    this.mostOpen = Math.max(this.mostOpen, this.open);
    for (const check of this.waiters) {
      check();
    }

    try {
      if (reply.kind === 'error') {
        throw reply.error;
      }

      return reply.kind === 'answer' ? replyWith(reply.output) : await this.hold(request, signal);
    } finally {
      this.open -= 1;
    }
  }

  /** No spec's code path sends a plain prompt; one that starts to has taken a wrong turn. */
  runPrompt(): never {
    throw new Error('The fake Claude answers structured prompts only');
  }

  /** Answers every held call — with `output`, or with the digest of what each was sent. */
  release(output?: unknown): void {
    for (const call of this.held) {
      call.resolve(replyWith(output ?? digestOf(call.request.prompt)));
    }

    this.held.clear();
  }

  /** Resolves once `count` prompts have been handed over — "the generation is in flight". */
  arrived(count: number, timeoutMs = 5_000): Promise<void> {
    if (this.calls.length >= count) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const forget = (): void => {
        this.waiters = this.waiters.filter((waiter) => waiter !== check);
      };
      const timer = setTimeout(() => {
        forget();
        reject(new Error(`Expected ${String(count)} prompts, saw ${String(this.calls.length)}`));
      }, timeoutMs);
      const check = (): void => {
        if (this.calls.length >= count) {
          clearTimeout(timer);
          forget();
          resolve();
        }
      };

      this.waiters.push(check);
    });
  }

  private hold(
    request: ClaudeStructuredPrompt,
    signal: AbortSignal,
  ): Promise<ClaudeStructuredReply> {
    return new Promise((resolve, reject) => {
      const call: HeldCall = { request, resolve };

      this.held.add(call);
      signal.addEventListener(
        'abort',
        () => {
          if (this.held.delete(call)) {
            this.hangUps += 1;
            reject(hungUpOn(signal));
          }
        },
        { once: true },
      );
    });
  }
}

function answerWithDigest(request: ClaudeStructuredPrompt): ClaudeReply {
  return { kind: 'answer', output: digestOf(request.prompt) };
}

function replyWith(output: unknown): ClaudeStructuredReply {
  return {
    output,
    model: FAKE_MODEL,
    costUsd: FAKE_COST_USD,
    inputTokens: 3_000,
    outputTokens: 300,
  };
}

function hungUpOn(signal: AbortSignal): ClaudeAgentError {
  return new ClaudeAgentError(ClaudeAgentFailure.FAILED, `${CLAUDE_MARKER}: hung up`, {
    cause: signal.reason,
  });
}
