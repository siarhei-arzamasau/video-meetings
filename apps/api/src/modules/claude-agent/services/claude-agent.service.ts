import type {
  Options,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ClaudeAgentFailure, ClaudeModel } from '../claude-agent.constants';
import { ClaudeAgentError } from '../claude-agent.error';

const AUTH_TOKEN_VARIABLE = 'ANTHROPIC_AUTH_TOKEN';

/**
 * All the Claude Code process is given of this one's environment. The SDK's `env` replaces
 * the environment rather than extending it, and that is relied on.
 *
 * The API's own secrets (`JWT_SECRET`, `DATABASE_URL`) are none of an agent process's
 * business. And an API started from inside a Claude Code session — an agent running
 * `pnpm dev` — inherits that session's `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_*`, which would
 * point the SDK, configured token and all, at that session's endpoint. A deployment that
 * reaches the network through a proxy adds its proxy variables here.
 */
const INHERITED_VARIABLES: readonly string[] = ['PATH', 'HOME', 'TMPDIR', 'LANG'];

/** One prompt, one answer: with no tools there is no result a second turn could read. */
const SINGLE_TURN = 1;

/** How the SDK marks an assistant message that is really the API refusing the credential. */
const REFUSED_CREDENTIAL: SDKAssistantMessageError = 'authentication_failed';

export interface ClaudeAgentReply {
  text: string;
  /** The model that answered, as the API named it — not merely the one asked for. */
  model: string;
  /** What the SDK reckons the call cost. */
  costUsd: number;
}

interface ClaudeAgentOutcome {
  result: SDKResultMessage;
  /** The last assistant message: it names the model, and carries the API's error if any. */
  answer: SDKAssistantMessage | undefined;
}

/**
 * Claude, through the Claude Agent SDK — which is Claude Code as a library: each call starts
 * a Claude Code process, and that process is what talks to Anthropic. Left to its defaults it
 * would read this repository's `.claude` settings and `.mcp.json`, hold Bash and file tools,
 * and authenticate with whatever it found on the host. Every option below takes one of those
 * away, so what is left is a prompt in and text out, paid for by `ANTHROPIC_AUTH_TOKEN`.
 */
@Injectable()
export class ClaudeAgentService {
  constructor(private readonly config: ConfigService) {}

  async runPrompt(prompt: string, model: ClaudeModel): Promise<ClaudeAgentReply> {
    const authToken = this.requireAuthToken();
    // Imported here, not at the top of the file: the SDK is ESM-only, and Jest cannot load
    // ESM without `--experimental-vm-modules`. A top-level import would run in every suite
    // that imports `AppModule`; this one runs only where a prompt is really sent, which is
    // `test:live`, and that script passes the flag. Node itself loads it either way.
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { result, answer } = await this.awaitOutcome(
      query({ prompt, options: this.optionsFor(model, authToken) }),
    );

    if (result.subtype !== 'success' || result.is_error || answer === undefined) {
      throw this.failureOf(result, answer);
    }

    return { text: result.result, model: answer.message.model, costUsd: result.total_cost_usd };
  }

  /** Read per call rather than in the constructor, so a spec can change it between tests. */
  private requireAuthToken(): string {
    const authToken = this.config.get<string>(AUTH_TOKEN_VARIABLE, '');

    if (authToken === '') {
      throw new ClaudeAgentError(
        ClaudeAgentFailure.NOT_CONFIGURED,
        `${AUTH_TOKEN_VARIABLE} is not set`,
      );
    }

    return authToken;
  }

  private optionsFor(model: ClaudeModel, authToken: string): Options {
    const inherited = INHERITED_VARIABLES.map((name) => [name, process.env[name]]);

    return {
      model,
      env: { ...Object.fromEntries(inherited), [AUTH_TOKEN_VARIABLE]: authToken },
      // No built-in tool, so no prompt can have the process read a file or run a command on
      // the API's host; `dontAsk` denies rather than waits, should one ever be added.
      tools: [],
      permissionMode: 'dontAsk',
      maxTurns: SINGLE_TURN,
      // Nothing from disk: neither this repository's settings nor the host user's, and no
      // MCP server from `.mcp.json`. Without these the answer depends on where it ran.
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
    };
  }

  /**
   * Returns at the result rather than draining the stream: after a result that reports an
   * error the SDK also throws, and returning here closes the process before it does.
   */
  private async awaitOutcome(messages: AsyncIterable<SDKMessage>): Promise<ClaudeAgentOutcome> {
    let answer: SDKAssistantMessage | undefined;

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

  private failureOf(
    result: SDKResultMessage,
    answer: SDKAssistantMessage | undefined,
  ): ClaudeAgentError {
    // An API error still arrives as a `success` result, its text being the error; `errors`
    // is only there when the turn itself could not finish.
    const detail = result.subtype === 'success' ? result.result : result.errors.join('; ');

    return answer?.error === REFUSED_CREDENTIAL
      ? new ClaudeAgentError(
          ClaudeAgentFailure.AUTHENTICATION,
          `Anthropic refused ${AUTH_TOKEN_VARIABLE}: ${detail}`,
        )
      : new ClaudeAgentError(ClaudeAgentFailure.FAILED, `Claude did not answer: ${detail}`);
  }
}
