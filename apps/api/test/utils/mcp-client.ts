import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import request from 'supertest';

import type { ApiSuite } from './api-suite';
import { listeningPort } from './http';
import type { RegisteredUser } from './meeting-files-suite';

/** What a Streamable HTTP client says it will take back. */
export const MCP_ACCEPT = 'application/json, text/event-stream';

/** The first message of every MCP exchange, as a plain request sends it. */
export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0.0.0' },
  },
};

/** The route as a client is configured with it: the meeting is in the URL. */
export const mcpUrl = (meetingId?: string): string =>
  meetingId === undefined ? '/api/mcp' : `/api/mcp?meetingId=${meetingId}`;

export interface ToolAnswer {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/** What a tool answered with, read back from the one text it sends. */
export const answerOf = (answer: ToolAnswer): unknown =>
  JSON.parse(answer.content[0]?.text ?? 'null');

/** A connected MCP client, with the two calls the specs make most. */
export interface ConnectedMcpClient {
  client: Client;
  callTool(name: string, input: Record<string, unknown>): Promise<ToolAnswer>;
  /** One resource, as the type it was answered under and the JSON its text holds. */
  readJson(uri: string): Promise<{ mimeType?: string; json: unknown }>;
}

/**
 * Connects the SDK's own HTTP client to the suite's API the way an MCP client is
 * configured — a URL that names the meeting, and the user's access token in a header —
 * runs `use` against it, and closes it whatever `use` did.
 */
export async function withMcpClient(
  suite: ApiSuite,
  meetingId: string,
  user: RegisteredUser,
  use: (connected: ConnectedMcpClient) => Promise<void>,
): Promise<void> {
  const port = await listeningPort(suite.app().getHttpServer());
  const client = new Client({ name: 'e2e', version: '0.0.0' });

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${mcpUrl(meetingId)}`), {
      requestInit: { headers: { Authorization: `Bearer ${user.token}` } },
    }),
  );

  try {
    await use({
      client,
      callTool: async (name, input) =>
        (await client.callTool({ name, arguments: input })) as ToolAnswer,
      readJson: async (uri) => {
        const { contents } = await client.readResource({ uri });
        const [content] = contents as Array<{ mimeType?: string; text: string }>;

        return { mimeType: content?.mimeType, json: JSON.parse(content?.text ?? 'null') };
      },
    });
  } finally {
    await client.close();
  }
}

/**
 * A plain `POST` of `body` to the route — for what the SDK's client would not send, or
 * would wrap: a refusal's status, a missing token, a body that is not one message.
 */
export function postToMcp(
  suite: ApiSuite,
  meetingId: string | undefined,
  token: string | undefined,
  body: object = INITIALIZE,
): request.Test {
  const sent = request(suite.app().getHttpServer())
    .post(mcpUrl(meetingId))
    .set('Accept', MCP_ACCEPT);

  return (token === undefined ? sent : sent.set('Authorization', `Bearer ${token}`)).send(body);
}
