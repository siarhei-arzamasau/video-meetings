import { Injectable } from '@nestjs/common';

/**
 * The two functions of the SDK that make tools of the API's own: `tool`, which describes
 * one, and `createSdkMcpServer`, which gathers them into a server that lives in this
 * process. Neither starts a process or sends anything.
 */
export type ClaudeAgentToolkit = Pick<
  typeof import('@anthropic-ai/claude-agent-sdk'),
  'tool' | 'createSdkMcpServer'
>;

/**
 * Where the SDK is loaded for its toolkit — imported inside the method and never at the top
 * of a file, for the reason `ClaudeAgentSdkLoader` gives: it is ESM-only, and a top-level
 * import would fail every Jest suite that imports `AppModule`.
 *
 * A provider apart from that loader, so that a module which only describes tools is not
 * handed the means to send a prompt, and so that a spec can describe tools without the SDK.
 */
@Injectable()
export class ClaudeAgentToolkitLoader {
  async loadToolkit(): Promise<ClaudeAgentToolkit> {
    const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');

    return { tool, createSdkMcpServer };
  }
}
