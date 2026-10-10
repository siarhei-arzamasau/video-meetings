import { TaskService } from '../src/modules/tasks/services/task.service';
import { useApiSuite } from './utils/api-suite';
import { EMAIL } from './utils/fixtures';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { truncateUsers } from './utils/users-table';

/** Restated rather than imported, as every stored vocabulary here is: see `fixtures.ts`. */
const OPEN = 'OPEN';
const DONE = 'DONE';

interface TaskRow {
  id: string;
  title: string;
  source_meeting_id: string;
  status: string;
}

/**
 * `TaskService` run against the database: what a search matches and in what order, what an
 * upsert writes, and what the two plain reads answer. The first two are raw SQL over
 * `pg_trgm` and `ON CONFLICT`, so a stubbed client can show neither.
 *
 * Every task here but the open ones is nobody's, as a digest's generation writes them, and
 * is searched as no user would. Whose task is whose is `task-owners.e2e-spec.ts`.
 */
describe('tasks, against the database', () => {
  const suite = useApiSuite();
  const tasks = (): TaskService => suite.app().get(TaskService);
  const newMeeting = async (): Promise<string> =>
    (await createMeeting(suite, await registerUser(suite, EMAIL))).id;
  const rows = (): Promise<TaskRow[]> =>
    suite
      .prisma()
      .$queryRawUnsafe<TaskRow[]>(
        'SELECT id, title, source_meeting_id, status::text FROM "tasks" ORDER BY title',
      );
  /** The meeting `seed` filled, which is the one `titlesFound` then searches. */
  let seededMeetingId = '';
  const titlesFound = async (query: string): Promise<string[]> =>
    (await tasks().search(query, seededMeetingId, null)).map(({ title }) => title);

  describe('upsert', () => {
    it('creates an open task of the meeting, and answers with the row it stored', async () => {
      const meetingId = await newMeeting();

      const task = await tasks().upsert({
        title: 'Rewrite the emails',
        sourceMeetingId: meetingId,
      });

      expect(task).toEqual({
        id: expect.any(String),
        title: 'Rewrite the emails',
        sourceMeetingId: meetingId,
        ownerId: null,
        status: OPEN,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      await expect(rows()).resolves.toEqual([
        { id: task.id, title: 'Rewrite the emails', source_meeting_id: meetingId, status: OPEN },
      ]);
    });

    it('updates the status of the task the meeting already has, and makes no second one', async () => {
      const meetingId = await newMeeting();
      const created = await tasks().upsert({ title: 'Call Bob', sourceMeetingId: meetingId });

      const updated = await tasks().upsert({
        title: 'Call Bob',
        sourceMeetingId: meetingId,
        status: DONE,
      });

      expect(updated).toMatchObject({ id: created.id, status: DONE, createdAt: created.createdAt });
      await expect(rows()).resolves.toHaveLength(1);
    });

    it('leaves the status of an existing task alone when none is given', async () => {
      const meetingId = await newMeeting();
      await tasks().upsert({ title: 'Call Bob', sourceMeetingId: meetingId, status: DONE });

      await expect(
        tasks().upsert({ title: 'Call Bob', sourceMeetingId: meetingId }),
      ).resolves.toMatchObject({ status: DONE });
    });

    it('keeps one title in two meetings as two tasks', async () => {
      const host = await registerUser(suite, EMAIL);
      const [first, second] = [await createMeeting(suite, host), await createMeeting(suite, host)];

      await tasks().upsert({ title: 'Call Bob', sourceMeetingId: first.id });
      await tasks().upsert({ title: 'Call Bob', sourceMeetingId: second.id });

      await expect(rows()).resolves.toHaveLength(2);
    });

    it('stores one task when the same one is upserted many times at once', async () => {
      const meetingId = await newMeeting();
      const upserts = Array.from({ length: 8 }, () =>
        tasks().upsert({ title: 'Call Bob', sourceMeetingId: meetingId }),
      );

      const ids = (await Promise.all(upserts)).map(({ id }) => id);

      expect(new Set(ids).size).toBe(1);
      await expect(rows()).resolves.toHaveLength(1);
    });

    it('refuses a task of a meeting that does not exist', async () => {
      await expect(
        tasks().upsert({
          title: 'Call Bob',
          sourceMeetingId: '99999999-9999-4999-8999-999999999999',
        }),
      ).rejects.toThrow(/tasks_source_meeting_id_fkey/);
      await expect(rows()).resolves.toEqual([]);
    });
  });

  describe('search', () => {
    const seed = async (...titles: string[]): Promise<void> => {
      seededMeetingId = await newMeeting();

      await Promise.all(
        titles.map((title) => tasks().upsert({ title, sourceMeetingId: seededMeetingId })),
      );
    };

    it('finds a task worded slightly differently, and leaves an unrelated one out', async () => {
      await seed('Rewrite the launch emails', 'Book the venue for the offsite');

      await expect(titlesFound('rewrite launch email')).resolves.toEqual([
        'Rewrite the launch emails',
      ]);
    });

    it('finds a task by one word of a long title, and through a typo in it', async () => {
      await seed('Prepare the quarterly report for the board meeting on Friday');

      await expect(titlesFound('quarterly')).resolves.toHaveLength(1);
      await expect(titlesFound('quartely report')).resolves.toHaveLength(1);
    });

    it('puts the most similar task first', async () => {
      await seed('Send the invoice to the client', 'Send the invoices to all the clients today');

      await expect(titlesFound('Send the invoice to the client')).resolves.toEqual([
        'Send the invoice to the client',
        'Send the invoices to all the clients today',
      ]);
    });

    it('matches text that is not Latin, whatever its case', async () => {
      await seed('Подготовить квартальный отчёт', 'Забронировать переговорную');

      await expect(titlesFound('квартальный ОТЧЁТ')).resolves.toEqual([
        'Подготовить квартальный отчёт',
      ]);
    });

    it('finds only the tasks of the meeting it is asked about', async () => {
      const host = await registerUser(suite, EMAIL);
      const [first, second] = [await createMeeting(suite, host), await createMeeting(suite, host)];
      await tasks().upsert({ title: 'Call Bob about the venue', sourceMeetingId: first.id });
      await tasks().upsert({ title: 'Call Bob about the budget', sourceMeetingId: second.id });

      const titlesIn = async (meetingId: string): Promise<string[]> =>
        (await tasks().search('Call Bob', meetingId, null)).map(({ title }) => title);

      await expect(titlesIn(second.id)).resolves.toEqual(['Call Bob about the budget']);
      await expect(titlesIn(first.id)).resolves.toEqual(['Call Bob about the venue']);
    });

    it('finds nothing for a blank text, or for one no task resembles', async () => {
      await seed('Rewrite the launch emails');

      await expect(titlesFound('   ')).resolves.toEqual([]);
      await expect(titlesFound('zzzz qqqq')).resolves.toEqual([]);
    });

    it('treats the text as text: a pattern or a quote in it matches nothing by itself', async () => {
      await seed('Rewrite the launch emails');

      await expect(titlesFound("%' OR 1=1 --")).resolves.toEqual([]);
    });
  });

  describe('open and get', () => {
    it("lists a reader's open tasks of a meeting, the oldest first, and none of another meeting's", async () => {
      const host = await registerUser(suite, EMAIL);
      const ownerId = host.id;
      const [first, second] = [await createMeeting(suite, host), await createMeeting(suite, host)];
      const oldest = await tasks().upsert({
        title: 'Book the venue',
        sourceMeetingId: first.id,
        ownerId,
      });
      await tasks().upsert({ title: 'Send the invitations', sourceMeetingId: first.id, ownerId });
      // Two upserts can land in the one millisecond the column keeps, and the order of a tie
      // is the ids': the first is dated back so that "oldest" is something the rows say.
      await suite.prisma().$executeRaw`
        UPDATE "tasks" SET created_at = now() - interval '1 minute' WHERE id = ${oldest.id}::uuid
      `;
      await tasks().upsert({
        title: 'Print the badges',
        sourceMeetingId: first.id,
        ownerId,
        status: DONE,
      });
      await tasks().upsert({ title: 'Call Bob', sourceMeetingId: second.id, ownerId });

      const open = await tasks().open(first.id, ownerId);

      expect(open.map(({ title }) => title)).toEqual(['Book the venue', 'Send the invitations']);
      expect(open.every(({ status }) => status === OPEN)).toBe(true);
    });

    it('reads one task by its id, whichever meeting it came out of, and null for an id no task has', async () => {
      const stored = await tasks().upsert({
        title: 'Book the venue',
        sourceMeetingId: await newMeeting(),
      });

      await expect(tasks().get(stored.id)).resolves.toEqual(stored);
      await expect(tasks().get('99999999-9999-4999-8999-999999999999')).resolves.toBeNull();
    });
  });

  it('is emptied by truncateUsers, so no spec needs a cleanup of its own', async () => {
    await tasks().upsert({ title: 'Call Bob', sourceMeetingId: await newMeeting() });

    await truncateUsers(suite.prisma());

    await expect(rows()).resolves.toEqual([]);
  });
});
