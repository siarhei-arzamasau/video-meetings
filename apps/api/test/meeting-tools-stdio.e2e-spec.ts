import { spawn } from 'node:child_process';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

import { TaskService } from '../src/modules/tasks/services/task.service';
import { useApiSuite } from './utils/api-suite';
import { EMAIL, OTHER_EMAIL } from './utils/fixtures';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const API_ROOT = path.resolve(__dirname, '..');
/** The entry point as `nest build` compiles it, run from source so no build has to exist. */
const SERVER_ARGS = ['-r', 'ts-node/register/transpile-only', 'src/meeting-tools-stdio.main.ts'];
const CONNECTED = 'Database connection established';
const CLOSED = 'The meeting tools server has closed';
/** Past the 10 MiB the SDK's transport will hold while it waits for the end of a frame. */
const OVERSIZED_FRAME_BYTES = 11 * 1024 * 1024;

// A start compiles the server's module graph before anything answers.
jest.setTimeout(60_000);

interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * The environment a client hands the subprocess: what the SDK passes by default, and the
 * database this suite runs on. The server reads the API's env files as well, and the
 * environment wins over them — which is what keeps it off a developer's own database.
 */
const serverEnvironment = (): Record<string, string> => ({
  ...getDefaultEnvironment(),
  DATABASE_URL: process.env['DATABASE_URL'] ?? '',
});

/** What a test does to the server's stdin once it is up: all a client has to end it with. */
type ClientsLastWord = (stdin: NodeJS.WritableStream) => void;

const closeThePipe: ClientsLastWord = (stdin) => stdin.end();
/** No newline, so no frame ever ends: the transport gives up on it and closes by itself. */
const sendAFrameTooLargeToBeOne: ClientsLastWord = (stdin) =>
  stdin.write(Buffer.alloc(OVERSIZED_FRAME_BYTES, 'a'));

/**
 * Starts the server with `args` and resolves once it has exited. `lastWord` is what is done
 * to its stdin once it has connected to the database, and done once.
 */
function runServer(args: string[], lastWord?: ClientsLastWord): Promise<Ended> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...SERVER_ARGS, ...args], {
      cwd: API_ROOT,
      env: serverEnvironment(),
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

/**
 * The meeting's tools served over stdio by a process of its own, started here the way an MCP
 * client starts it. What the tool does is `MeetingToolsStdioServer`'s unit spec; this is what
 * only a real subprocess can show: that stdout carries the protocol and nothing else, that
 * the meeting on the command line is the one that is searched, and that it ends with its
 * client.
 */
describe('the meeting tools, served over stdio by a subprocess', () => {
  const suite = useApiSuite();
  const tasks = (): TaskService => suite.app().get(TaskService);

  it('answers a client with find_tasks, for the meeting it was started for and no other', async () => {
    const host = await registerUser(suite, EMAIL);
    const other = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host);
    const otherMeeting = await createMeeting(suite, other);
    await tasks().upsert({ title: 'Rewrite the launch emails', sourceMeetingId: meeting.id });
    await tasks().upsert({ title: 'Rewrite the launch emails', sourceMeetingId: otherMeeting.id });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...SERVER_ARGS, meeting.id],
      cwd: API_ROOT,
      env: serverEnvironment(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      // The handshake itself is the proof that nothing but frames was written to stdout.
      await client.connect(transport);

      expect(client.getServerVersion()).toMatchObject({ name: 'meeting' });
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual(['find_tasks']);

      const answer = await client.callTool({
        name: 'find_tasks',
        arguments: { query: 'launch emails' },
      });
      const [content] = answer.content as Array<{ type: string; text: string }>;

      expect(JSON.parse(content?.text ?? 'null')).toEqual({
        tasks: [
          {
            id: expect.any(String),
            title: 'Rewrite the launch emails',
            status: 'OPEN',
            sourceMeetingId: meeting.id,
          },
        ],
      });
      // What Nest had to say went where a client does not read frames from.
      expect(stderr).toContain(CONNECTED);
    } finally {
      await client.close();
    }
  });

  it.each([
    ['its client closes the pipe', closeThePipe],
    // The transport stops reading stdin here, so the pipe's end is never seen: without the
    // server's own close as a way in, the process outlived its client.
    ['its client sends a frame too large to be one', sendAFrameTooLargeToBeOne],
  ])('ends by itself when %s, having written nothing to stdout', async (_case, lastWord) => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const ended = await runServer([meeting.id], lastWord);

    // Not killed: it closed its server and its database connection, and said so.
    expect(ended).toMatchObject({ code: 0, signal: null, stdout: '' });
    expect(ended.stderr).toContain(CLOSED);
  });

  it.each([
    ['no meeting', []],
    ['a meeting id that is not one', ['not-a-uuid']],
  ])('refuses to start with %s, and says how to on stderr', async (_case, args) => {
    const ended = await runServer(args);

    expect(ended).toMatchObject({ code: 1, signal: null, stdout: '' });
    expect(ended.stderr).toContain('Usage:');
    // It never got as far as the database.
    expect(ended.stderr).not.toContain(CONNECTED);
  });
});
