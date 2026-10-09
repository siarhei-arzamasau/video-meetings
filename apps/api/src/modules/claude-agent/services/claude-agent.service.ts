import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ClaudeAgentFailure, ClaudeModel } from '../claude-agent.constants';
import { ClaudeAgentError } from '../claude-agent.error';
import { readExchange } from './claude-agent-exchange';
import { outcomeOf, structuredOutcomeOf } from './claude-agent-outcome';
import type { ClaudeAgentExchange } from './claude-agent-outcome';
import { ClaudeAgentSdkLoader } from './claude-agent-sdk.loader';
import { toolOptionsOf } from './claude-agent-tools';
import type { ClaudeAgentTools } from './claude-agent-tools';

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

const CALLED_OFF = 'The prompt was called off before Claude Code was started';
const ANSWERED_TOO_LATE = 'The prompt was called off, and the answer that followed is discarded';

/**
 * One prompt, one answer: with no tools there is no result a second turn could read. A
 * call that names tools of the API's own has a cap of its own, `MAX_TOOL_RUN_TURNS`.
 *
 * **A schema-bound answer fits this cap too, and it was measured rather than assumed.** With
 * `outputFormat` the SDK gives the model one tool of its own, `StructuredOutput` — there
 * whatever `tools` says, and the only tool the process then holds — and the model answers by
 * calling it. That call ends the turn: the SDK checks its input against the schema and hands
 * it back as `structured_output`, with no second request. On 2026-10-08, SDK 0.3.292 and
 * `claude-sonnet-5-5`: one request to the API and a `success` result under this cap, though
 * the result counts the tool's own reply as a turn and reports `num_turns: 2`.
 *
 * What the cap costs is the correction: an input the SDK rejects against the schema would
 * need a second request to put right, and here it ends as a failure instead. Raise this
 * only for that, and only with the process still holding no tool that touches the host.
 */
const SINGLE_TURN = 1;

export interface ClaudeAgentReply {
  text: string;
  /** The model that answered, as the API named it — not merely the one asked for. */
  model: string;
  /** What the SDK reckons the call cost. */
  costUsd: number;
}

export interface ClaudeStructuredPrompt {
  model: ClaudeModel;
  /** Replaces Claude Code's own system prompt, which is about writing code. */
  systemPrompt: string;
  prompt: string;
  /** A JSON schema the answer is bound to. The SDK checks the answer against it. */
  schema: Record<string, unknown>;
  /**
   * Tools of the API's own the run may call before it answers. Left out, the run holds
   * none and is one turn. The answer is bound to `schema` either way.
   */
  tools?: ClaudeAgentTools;
}

export interface ClaudeStructuredReply {
  /**
   * What the model answered through the schema. **Still `unknown`**: the schema was enforced
   * by the provider, which is the provider's word, and a caller validates it again.
   */
  output: unknown;
  model: string;
  costUsd: number;
  /** Everything the model read — the prompt, the system prompt, and the SDK's own framing. */
  inputTokens: number;
  outputTokens: number;
}

/**
 * Claude, through the Claude Agent SDK — which is Claude Code as a library: each call starts
 * a Claude Code process, and that process is what talks to Anthropic. Left to its defaults it
 * would read this repository's `.claude` settings and `.mcp.json`, hold Bash and file tools,
 * and authenticate with whatever it found on the host. Every option below takes one of those
 * away, so what is left is a prompt in and an answer out — text, or an object bound to a
 * schema — paid for by `ANTHROPIC_AUTH_TOKEN`.
 */
@Injectable()
export class ClaudeAgentService {
  constructor(
    private readonly config: ConfigService,
    private readonly sdkLoader: ClaudeAgentSdkLoader,
  ) {}

  async runPrompt(prompt: string, model: ClaudeModel): Promise<ClaudeAgentReply> {
    const options = this.optionsFor(model, this.requireAuthToken());
    const outcome = outcomeOf(await this.exchange(prompt, options));

    if (outcome instanceof ClaudeAgentError) {
      throw outcome;
    }

    return { text: outcome.text, model: outcome.model, costUsd: outcome.costUsd };
  }

  /**
   * A prompt in and an object out, bound to `schema` — no tool that reaches the host, a
   * replaced environment, and nothing from disk. One turn, unless the request names tools
   * of the API's own: then those and no others, for as many turns as `toolOptionsOf` says.
   *
   * **`signal` hangs up, and a call that was hung up on never resolves.** The SDK closes the
   * process's input and kills it about two seconds later, so the rejection follows the abort
   * by that much; an answer that arrives inside those two seconds is discarded, its cost
   * reported on the error. Otherwise whether a time limit ended in an answer would depend on
   * which side of the limit the last token fell. Why it was called off is the caller's to
   * know, since the signal is the caller's: the failure is `FAILED` either way.
   */
  async runStructuredPrompt(
    request: ClaudeStructuredPrompt,
    signal: AbortSignal,
  ): Promise<ClaudeStructuredReply> {
    const authToken = this.requireAuthToken();

    if (signal.aborted) {
      throw new ClaudeAgentError(ClaudeAgentFailure.FAILED, CALLED_OFF, { cause: signal.reason });
    }

    // The SDK takes a controller, not a signal, so the caller's signal is forwarded to one.
    const abortController = new AbortController();
    const forwardAbort = (): void => abortController.abort(signal.reason);
    signal.addEventListener('abort', forwardAbort, { once: true });

    try {
      const exchange = await this.exchange(request.prompt, {
        ...this.optionsFor(request.model, authToken),
        ...(request.tools === undefined ? {} : await toolOptionsOf(request.tools)),
        systemPrompt: request.systemPrompt,
        outputFormat: { type: 'json_schema', schema: request.schema },
        abortController,
      });

      if (signal.aborted) {
        throw new ClaudeAgentError(ClaudeAgentFailure.FAILED, ANSWERED_TOO_LATE, {
          cause: signal.reason,
          costUsd: exchange.result.total_cost_usd,
        });
      }

      const outcome = structuredOutcomeOf(exchange);

      if (outcome instanceof ClaudeAgentError) {
        throw outcome;
      }

      const { structuredOutput: output, model, costUsd, inputTokens, outputTokens } = outcome;

      return { output, model, costUsd, inputTokens, outputTokens };
    } finally {
      signal.removeEventListener('abort', forwardAbort);
    }
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
      // the API's host; `dontAsk` denies rather than waits, should one ever be added. The one
      // tool a schema-bound call still holds is the SDK's `StructuredOutput`, which takes the
      // answer and does nothing else.
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
   * Starts Claude Code on one prompt and waits for how it ended. `ClaudeAgentSdkLoader` says
   * why the SDK is loaded per call, and not imported at the top of this file.
   */
  private async exchange(prompt: string, options: Options): Promise<ClaudeAgentExchange> {
    const query = await this.sdkLoader.loadQuery();

    // That load is the one wait between the caller's signal being checked and the process
    // starting, and a process must not be started for a call that was hung up on meanwhile.
    if (options.abortController?.signal.aborted) {
      throw new ClaudeAgentError(ClaudeAgentFailure.FAILED, CALLED_OFF, {
        cause: options.abortController.signal.reason,
      });
    }

    return readExchange(query({ prompt, options }));
  }
}
