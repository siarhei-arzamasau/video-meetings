import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Injectable } from '@nestjs/common';

/**
 * All this module calls of the SDK: a prompt and its options in, and the messages of the
 * Claude Code process that was started for them out.
 */
export type ClaudeAgentQuery = (request: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/**
 * Where the SDK is loaded, and the one place in the API that does it.
 *
 * **Imported here, inside the method, and never at the top of a file**: the SDK is ESM-only,
 * and Jest cannot load ESM without `--experimental-vm-modules`. A top-level import would run
 * in every suite that imports `AppModule`; this one runs only where a prompt is really sent,
 * which is `test:live`, and that script passes the flag. Node itself loads it either way.
 *
 * A provider of its own so that a spec can hand `ClaudeAgentService` a scripted process in
 * its place, and hold the service to what it decides around one — what it starts it with,
 * and what it does with an answer once its caller has hung up — without paying for a request.
 */
@Injectable()
export class ClaudeAgentSdkLoader {
  async loadQuery(): Promise<ClaudeAgentQuery> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    return query;
  }
}
