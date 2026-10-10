import { spawn } from 'node:child_process';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

import { MEETING_TOOLS_ACCESS_TOKEN_VARIABLE } from '../../src/config/env.validation.meeting-tools-stdio';

const API_ROOT = path.resolve(__dirname, '../..');
/** The entry point as `nest build` compiles it, run from source so no build has to exist. */
const SERVER_ARGS = ['-r', 'ts-node/register/transpile-only', 'src/meeting-tools-stdio.main.ts'];

/** What the server's log says once it holds a database connection, and once it has let go. */
export const CONNECTED = 'Database connection established';
export const CLOSED = 'The meeting tools server has closed';

/** How a spec hands the server no token at all. */
export const NO_ACCESS_TOKEN = undefined;

export interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ToolAnswer {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/** What a test does to the server's stdin once it is up: all a client has to end it with. */
export type ClientsLastWord = (stdin: NodeJS.WritableStream) => void;

/**
 * The environment a client hands the subprocess: what the SDK passes by default, the
 * database and the signing key this suite runs on, and its user's access token. The server
 * reads the API's env files as well, and the environment wins over them — which is what
 * keeps it off a developer's own database, and verifying with the key the suite's API signs
 * with rather than the one in a developer's `.env`.
 */
function serverEnvironment(accessToken: string | undefined): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    DATABASE_URL: process.env['DATABASE_URL'] ?? '',
    JWT_SECRET: process.env['JWT_SECRET'] ?? '',
    // Set to nothing rather than left out, so a token in a developer's env file is not read.
    [MEETING_TOOLS_ACCESS_TOKEN_VARIABLE]: accessToken ?? '',
  };
}

/**
 * Starts the server with `args` and resolves once it has exited. `lastWord` is what is done
 * to its stdin once it has connected to the database, and done once.
 */
export function runServer(
  args: string[],
  accessToken: string | undefined,
  lastWord?: ClientsLastWord,
): Promise<Ended> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...SERVER_ARGS, ...args], {
      cwd: API_ROOT,
      env: serverEnvironment(accessToken),
    });
    let stdout = '';
    let stderr = '';
    let said = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();

      if (lastWord !== undefined && !said && stderr.includes(CONNECTED)) {
        said = true;
        lastWord(child.stdin);
      }
    });
    // A server that has stopped reading closes its end; what was still being written to it
    // is then refused, and that is the case under test rather than a failure of it.
    child.stdin.on('error', () => undefined);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** A connected MCP client, and what its server has written to stderr so far. */
export interface ConnectedClient {
  client: Client;
  stderr(): string;
  callTool(name: string, input: Record<string, unknown>): Promise<ToolAnswer>;
  /** One resource, as the type it was answered under and the JSON its text holds. */
  readJson(uri: string): Promise<{ mimeType?: string; json: unknown }>;
}

/**
 * Starts the server for `meetingId` the way an MCP client does — as its subprocess, over
 * stdio — runs `use` against it, and closes it whatever `use` did. The handshake inside is
 * itself the proof that nothing but frames was written to stdout.
 */
export async function withMcpClient(
  meetingId: string,
  accessToken: string,
  use: (connected: ConnectedClient) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...SERVER_ARGS, meetingId],
    cwd: API_ROOT,
    env: serverEnvironment(accessToken),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    await client.connect(transport);
    await use({
      client,
      stderr: () => stderr,
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

/** What a tool answered with, read back from the one text it sends. */
export const answerOf = (answer: ToolAnswer): unknown =>
  JSON.parse(answer.content[0]?.text ?? 'null');
