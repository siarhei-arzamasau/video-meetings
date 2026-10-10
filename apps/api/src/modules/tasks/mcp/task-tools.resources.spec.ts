import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Logger } from '@nestjs/common';

import {
  MEETING_ID,
  OTHER_MEETING_ID,
  OTHER_USER_ID,
  REFUSAL,
  REQUESTER,
  TASK,
  TASK_AS_ANSWERED,
  connectTaskTools,
} from './task-tools.fixture';
import type { TaskToolsHarness } from './task-tools.fixture';

const OPEN_TASKS = 'tasks://open';
const TASK_URI = `task://${TASK.id}`;

/** The domain's two resources, read by a real MCP client (`task-tools.fixture.ts`). */
describe("TaskTools' resources", () => {
  let server: TaskToolsHarness;
  let client: Client;
  let open: jest.Mock;
  let get: jest.Mock;
  let admit: TaskToolsHarness['admit'];

  beforeEach(async () => {
    server = await connectTaskTools();
    ({ client, open, get, admit } = server);
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
    it("answers the task service's open tasks of the requester in the one meeting, as JSON", async () => {
      await expect(server.readJson(OPEN_TASKS)).resolves.toEqual({
        uri: OPEN_TASKS,
        mimeType: 'application/json',
        json: { tasks: [TASK_AS_ANSWERED] },
      });
      expect(open).toHaveBeenCalledWith(MEETING_ID, REQUESTER.userId);
    });

    it('answers whoever the gate let in this time with theirs', async () => {
      admit.mockResolvedValue({ requester: { userId: OTHER_USER_ID } });

      await server.readJson(OPEN_TASKS);

      expect(open).toHaveBeenCalledWith(MEETING_ID, OTHER_USER_ID);
    });

    it('answers an empty list for a meeting with nothing open', async () => {
      open.mockResolvedValue([]);

      await expect(server.readJson(OPEN_TASKS)).resolves.toMatchObject({ json: { tasks: [] } });
    });
  });

  describe('task://{taskId}', () => {
    it("answers the task of that id from the task service when it is the requester's, as JSON", async () => {
      await expect(server.readJson(TASK_URI)).resolves.toEqual({
        uri: TASK_URI,
        mimeType: 'application/json',
        json: { task: TASK_AS_ANSWERED },
      });
      expect(get).toHaveBeenCalledWith(TASK.id);
    });

    it.each([
      ['a task of another meeting', { ...TASK, sourceMeetingId: OTHER_MEETING_ID }],
      [
        "another meeting's task that is somebody else's",
        { ...TASK, sourceMeetingId: OTHER_MEETING_ID, ownerId: OTHER_USER_ID },
      ],
      ['no task at all', null],
    ])('refuses an id that names %s, in one sentence for both', async (_case, found) => {
      get.mockResolvedValue(found);

      // An id is its reader's to choose: answered, it would read a meeting they cannot see.
      await expect(server.readJson(TASK_URI)).rejects.toThrow('There is no such task.');
    });

    it.each([
      ["somebody else's", OTHER_USER_ID],
      ["nobody's", null],
    ])('refuses a task of the meeting that is %s as forbidden', async (_case, ownerId) => {
      get.mockResolvedValue({ ...TASK, ownerId });

      const read = server.readJson(TASK_URI);

      // The id said which task to look for; whose it is was read off the task.
      await expect(read).rejects.toMatchObject({ code: 403 });
      await expect(read).rejects.toThrow('This task is not yours.');
      // A refusal, not a failure: nothing went wrong that a log should hold.
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('refuses an id that is not one without asking the task service', async () => {
      await expect(server.readJson('task://not-a-uuid')).rejects.toThrow('There is no such task.');
      expect(get).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['tasks://open', OPEN_TASKS],
    ['task://{taskId}', TASK_URI],
  ])("%s, behind the scope's gate", (_resource, uri) => {
    it('asks the gate before every read, not once', async () => {
      await server.readJson(uri);
      await server.readJson(uri);

      expect(admit).toHaveBeenCalledTimes(2);
    });

    it("answers a refusal as an error in the gate's own words, and reads no task", async () => {
      admit.mockResolvedValue({ refusal: REFUSAL });

      await expect(server.readJson(uri)).rejects.toThrow(REFUSAL);
      expect(open).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });

    it('stays closed when the gate itself fails', async () => {
      admit.mockRejectedValue(new Error('relation "meetings" does not exist'));

      await expect(server.readJson(uri)).rejects.toThrow('Access could not be checked.');
      expect(open).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });

    it('lets in only an answer that names a requester, not one that merely refuses nothing', async () => {
      admit.mockResolvedValue({} as never);

      await expect(server.readJson(uri)).rejects.toThrow('Access could not be checked.');
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
