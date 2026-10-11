import { PrismaService } from '../../prisma/prisma.service';
import { MAX_TASKS_PER_OWNER, OPEN_TASKS_LIMIT, TASK_SEARCH_LIMIT } from '../task.constants';
import { TaskLimitReachedError, TaskService } from './task.service';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';

const TASK = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Rewrite the launch emails',
  sourceMeetingId: MEETING_ID,
  ownerId: OWNER_ID,
  status: 'OPEN' as const,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  updatedAt: new Date('2026-10-01T10:00:00.000Z'),
};

/**
 * What a stubbed client can show: what each statement is given, and what the service makes
 * of the rows that come back. What the statements match, order, and write is
 * `test/tasks.e2e-spec.ts`'s, against a real database.
 */
describe('TaskService', () => {
  const queryRaw = jest.fn();
  const findMany = jest.fn();
  const findUnique = jest.fn();
  const tasks = new TaskService({
    $queryRaw: queryRaw,
    task: { findMany, findUnique },
  } as unknown as PrismaService);

  /** The values bound into the one statement that was run, in the order it names them. */
  const boundValues = (): unknown[] => (queryRaw.mock.calls[0] as unknown[]).slice(1);
  /** The text of that statement, with a gap where each value is bound. */
  const statement = (): string => ((queryRaw.mock.calls[0] as unknown[])[0] as string[]).join('?');

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([TASK]);
    findMany.mockReset().mockResolvedValue([TASK]);
    findUnique.mockReset().mockResolvedValue(TASK);
  });

  describe('search', () => {
    it('answers with the rows the statement found', async () => {
      await expect(tasks.search('launch emails', MEETING_ID, OWNER_ID)).resolves.toEqual([TASK]);
    });

    it('binds the text, trimmed, and the limit — never as part of the statement', async () => {
      await tasks.search('  launch emails ', MEETING_ID, OWNER_ID);

      expect(boundValues()[1]).toBe('launch emails');
      expect(boundValues().at(-1)).toBe(TASK_SEARCH_LIMIT);
      expect(boundValues().filter((value) => value === 'launch emails')).toHaveLength(4);
    });

    it('binds the meeting and the reader, every time: there is no search of everything', async () => {
      await tasks.search('launch emails', MEETING_ID, OWNER_ID);

      expect(boundValues()).toContain(MEETING_ID);
      expect(boundValues()).toContain(OWNER_ID);
      expect(statement()).toContain('source_meeting_id = ');
      // Nobody's tasks beside the reader's own, and no other user's.
      expect(statement()).toContain('(owner_id IS NULL OR owner_id = ');
    });

    it('binds null for a reader who is no user, which leaves the tasks nobody owns', async () => {
      await tasks.search('launch emails', MEETING_ID, null);

      expect(boundValues()).toContain(null);
      expect(boundValues()).not.toContain(OWNER_ID);
    });

    it.each(['', '   ', '\n\t'])(
      'finds nothing for the blank text %j, without asking',
      async (text) => {
        await expect(tasks.search(text, MEETING_ID, OWNER_ID)).resolves.toEqual([]);

        expect(queryRaw).not.toHaveBeenCalled();
      },
    );
  });

  describe('upsert', () => {
    it('answers with the row the statement returned', async () => {
      await expect(
        tasks.upsert({ title: TASK.title, sourceMeetingId: MEETING_ID }),
      ).resolves.toEqual(TASK);
    });

    it('binds the title as given, the meeting, the owner, and the status for both branches', async () => {
      await tasks.upsert({
        title: ' Call Bob ',
        sourceMeetingId: MEETING_ID,
        ownerId: OWNER_ID,
        status: 'DONE',
      });

      expect(boundValues().slice(0, 4)).toEqual([' Call Bob ', MEETING_ID, OWNER_ID, 'DONE']);
      // Once for the insert and once for the update of a task that is already there.
      expect(boundValues().filter((value) => value === 'DONE')).toHaveLength(2);
    });

    it('binds no status when none is given, so an existing task keeps its own', async () => {
      await tasks.upsert({ title: TASK.title, sourceMeetingId: MEETING_ID, ownerId: OWNER_ID });

      expect(boundValues().filter((value) => value === null)).toHaveLength(2);
    });

    it("binds no owner when none is given: the task is nobody's", async () => {
      await tasks.upsert({ title: TASK.title, sourceMeetingId: MEETING_ID });

      expect(boundValues()[2]).toBeNull();
    });

    it('binds the most tasks an owner may have, counted among their own of the meeting', async () => {
      await tasks.upsert({ title: TASK.title, sourceMeetingId: MEETING_ID, ownerId: OWNER_ID });

      expect(boundValues()).toContain(MAX_TASKS_PER_OWNER);
      expect(JSON.stringify(boundValues())).toContain('owner_id IS NOT DISTINCT FROM ');
    });

    it('throws that the limit is reached when the statement wrote nothing', async () => {
      queryRaw.mockResolvedValue([]);

      // The one case the statement leaves out: a task that is new, and one too many.
      await expect(
        tasks.upsert({ title: TASK.title, sourceMeetingId: MEETING_ID }),
      ).rejects.toBeInstanceOf(TaskLimitReachedError);
    });

    it('lets the failure of the statement through', async () => {
      const failure = new Error('violates foreign key constraint');
      queryRaw.mockRejectedValue(failure);

      await expect(tasks.upsert({ title: TASK.title, sourceMeetingId: MEETING_ID })).rejects.toBe(
        failure,
      );
    });
  });

  describe('open', () => {
    it('answers the open tasks of the meeting a reader may see, the oldest first, and no more than the limit', async () => {
      await expect(tasks.open(MEETING_ID, OWNER_ID)).resolves.toEqual([TASK]);

      // The whole argument: a status, a meeting or the two owners dropped from it is every
      // task, or everyone's.
      expect(findMany).toHaveBeenCalledWith({
        where: {
          sourceMeetingId: MEETING_ID,
          status: 'OPEN',
          OR: [{ ownerId: null }, { ownerId: OWNER_ID }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: OPEN_TASKS_LIMIT,
      });
    });
  });

  describe('get', () => {
    it('answers the task of that id', async () => {
      await expect(tasks.get(TASK.id)).resolves.toEqual(TASK);

      expect(findUnique).toHaveBeenCalledWith({ where: { id: TASK.id } });
    });

    it('resolves to null for an id no task has, rather than throwing', async () => {
      findUnique.mockResolvedValue(null);

      // What a miss means is the caller's — as is whose meeting the task came out of.
      await expect(tasks.get(TASK.id)).resolves.toBeNull();
    });
  });
});
