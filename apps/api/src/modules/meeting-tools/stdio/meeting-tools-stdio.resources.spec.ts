import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Logger } from '@nestjs/common';

import { MEETING_ID, OTHER_MEETING_ID, TASK, TASK_AS_ANSWERED } from '../meeting-tools.fixture';
import { MeetingToolsStdioAccessOutcome } from './meeting-tools-stdio.access';
import { ACCESS_TOKEN, connectStdioServer, refusedAs } from './meeting-tools-stdio.fixture';
import type { StdioServerHarness } from './meeting-tools-stdio.fixture';

const OPEN_TASKS = 'tasks://open';
const TASK_URI = `task://${TASK.id}`;

/** The server's two resources, read by a real MCP client (`meeting-tools-stdio.fixture.ts`). */
describe("MeetingToolsStdioServer's resources", () => {
  let server: StdioServerHarness;
  let client: Client;
  let open: jest.Mock;
  let get: jest.Mock;
  let check: jest.Mock;

  beforeEach(async () => {
    server = await connectStdioServer();
    ({ client, open, get, check } = server);
  });

  afterEach(async () => {
    await client.close();
    jest.restoreAllMocks();
  });

  it('lists the open tasks at a fixed address, as JSON, and no task by itself', async () => {
    const { resources } = await client.listResources();

    // The template lists nothing: a task is found by search, and then read by its id.
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      uri: OPEN_TASKS,
      name: 'open-tasks',
      mimeType: 'application/json',
    });
  });

  it('offers one task at an address made from its id', async () => {
    const { resourceTemplates } = await client.listResourceTemplates();

    expect(resourceTemplates).toHaveLength(1);
    expect(resourceTemplates[0]).toMatchObject({
      uriTemplate: 'task://{taskId}',
      name: 'task',
      mimeType: 'application/json',
    });
  });

  describe('tasks://open', () => {
    it("answers the task service's open tasks of the one meeting, as JSON", async () => {
      await expect(server.readJson(OPEN_TASKS)).resolves.toEqual({
        uri: OPEN_TASKS,
        mimeType: 'application/json',
        json: { tasks: [TASK_AS_ANSWERED] },
      });
      expect(open).toHaveBeenCalledWith(MEETING_ID);
    });

    it('answers an empty list for a meeting with nothing open', async () => {
      open.mockResolvedValue([]);

      await expect(server.readJson(OPEN_TASKS)).resolves.toMatchObject({ json: { tasks: [] } });
    });
  });

  describe('task://{taskId}', () => {
    it('answers the task of that id from the task service, as JSON', async () => {
      await expect(server.readJson(TASK_URI)).resolves.toEqual({
        uri: TASK_URI,
        mimeType: 'application/json',
        json: { task: TASK_AS_ANSWERED },
      });
      expect(get).toHaveBeenCalledWith(TASK.id);
    });

    it.each([
      ['a task of another meeting', { ...TASK, sourceMeetingId: OTHER_MEETING_ID }],
      ['no task at all', null],
    ])('refuses an id that names %s, in one sentence for both', async (_case, found) => {
      get.mockResolvedValue(found);

      // An id is its reader's to choose: answered, it would read a meeting they cannot see.
      await expect(server.readJson(TASK_URI)).rejects.toThrow('There is no such task.');
    });

    it('refuses an id that is not one without asking the task service', async () => {
      await expect(server.readJson('task://not-a-uuid')).rejects.toThrow('There is no such task.');
      expect(get).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['tasks://open', OPEN_TASKS],
    ['task://{taskId}', TASK_URI],
  ])('%s, for the user the server answers for', (_resource, uri) => {
    it('checks the user against the meeting before every read, not once', async () => {
      await server.readJson(uri);
      await server.readJson(uri);

      expect(check).toHaveBeenCalledTimes(2);
      expect(check).toHaveBeenCalledWith(ACCESS_TOKEN, MEETING_ID);
    });

    it.each([
      [MeetingToolsStdioAccessOutcome.TOKEN_REFUSED, /access token was refused/],
      [MeetingToolsStdioAccessOutcome.MEETING_NOT_FOUND, /no such meeting/],
    ] as const)(
      'answers %s as an error that says so, and reads no task',
      async (outcome, reason) => {
        check.mockResolvedValue(refusedAs(outcome));

        await expect(server.readJson(uri)).rejects.toThrow(reason);
        expect(open).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
      },
    );

    it('stays closed when the check itself fails', async () => {
      check.mockRejectedValue(new Error('relation "meetings" does not exist'));

      await expect(server.readJson(uri)).rejects.toThrow(
        'Access to the tasks could not be checked.',
      );
      expect(open).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });

    it('lets in only an answer that names a requester, not one that merely refuses nothing', async () => {
      check.mockResolvedValue({ outcome: 'SOMETHING_NEW' });

      await expect(server.readJson(uri)).rejects.toThrow();
      expect(open).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });

    it('answers a failed read as an error of its own wording, and logs the cause', async () => {
      const failure = new Error('relation "tasks" does not exist');
      open.mockRejectedValue(failure);
      get.mockRejectedValue(failure);

      const read = server.readJson(uri);

      await expect(read).rejects.toThrow('The tasks could not be read.');
      await expect(read).rejects.not.toThrow(/relation/);
      expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    });
  });
});
