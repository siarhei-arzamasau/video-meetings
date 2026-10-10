import { TaskService } from '../src/modules/tasks/services/task.service';
import { useApiSuite } from './utils/api-suite';
import { EMAIL, OTHER_EMAIL } from './utils/fixtures';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { CLOSED, CONNECTED, answerOf, runServer, withMcpClient } from './utils/meeting-tools-stdio';
import type { ClientsLastWord } from './utils/meeting-tools-stdio';

/** Past the 10 MiB the SDK's transport will hold while it waits for the end of a frame. */
const OVERSIZED_FRAME_BYTES = 11 * 1024 * 1024;

// A start compiles the server's module graph before anything answers.
jest.setTimeout(60_000);

const closeThePipe: ClientsLastWord = (stdin) => stdin.end();
/** No newline, so no frame ever ends: the transport gives up on it and closes by itself. */
const sendAFrameTooLargeToBeOne: ClientsLastWord = (stdin) =>
  stdin.write(Buffer.alloc(OVERSIZED_FRAME_BYTES, 'a'));

/**
 * The meeting's tasks served over stdio by a process of its own, started here the way an MCP
 * client starts it. What the tools do is `MeetingToolsStdioServer`'s unit spec, and what a
 * client is served, and who is served at all, is `mcp-server.e2e-spec.ts`; this is what only a real subprocess
 * can show: that stdout carries the protocol and nothing else, that the meeting on the
 * command line is the one that is searched, and that it ends with its client.
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

    await withMcpClient(meeting.id, host.token, async ({ client, callTool, stderr }) => {
      expect(client.getServerVersion()).toMatchObject({ name: 'meeting' });
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual(['find_tasks', 'upsert_task']);

      const answer = await callTool('find_tasks', { query: 'launch emails' });

      expect(answerOf(answer)).toEqual({
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
      expect(stderr()).toContain(CONNECTED);
    });
  });

  it('is the same server for a meeting id written in capitals', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const task = await tasks().upsert({ title: 'Book the venue', sourceMeetingId: meeting.id });

    await withMcpClient(meeting.id.toUpperCase(), host.token, async ({ readJson }) => {
      // The one place the id is compared as text: a task is matched to its meeting.
      await expect(readJson(`task://${task.id}`)).resolves.toMatchObject({
        json: { task: { id: task.id, sourceMeetingId: meeting.id } },
      });
    });
  });

  it.each([
    ['its client closes the pipe', closeThePipe],
    // The transport stops reading stdin here, so the pipe's end is never seen: without the
    // server's own close as a way in, the process outlived its client.
    ['its client sends a frame too large to be one', sendAFrameTooLargeToBeOne],
  ])('ends by itself when %s, having written nothing to stdout', async (_case, lastWord) => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const ended = await runServer([meeting.id], host.token, lastWord);

    // Not killed: it closed its server and its database connection, and said so.
    expect(ended).toMatchObject({ code: 0, signal: null, stdout: '' });
    expect(ended.stderr).toContain(CLOSED);
  });

  it.each([
    ['no meeting', []],
    ['a meeting id that is not one', ['not-a-uuid']],
  ])('refuses to start with %s, and says how to on stderr', async (_case, args) => {
    const host = await registerUser(suite, EMAIL);

    const ended = await runServer(args, host.token);

    expect(ended).toMatchObject({ code: 1, signal: null, stdout: '' });
    expect(ended.stderr).toContain('Usage:');
    // It never got as far as the database.
    expect(ended.stderr).not.toContain(CONNECTED);
  });
});
