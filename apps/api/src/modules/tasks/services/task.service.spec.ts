import { PrismaService } from '../../prisma/prisma.service';
import { OPEN_TASKS_LIMIT, TASK_SEARCH_LIMIT } from '../task.constants';
import { TaskService } from './task.service';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';

const TASK = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Rewrite the launch emails',
  sourceMeetingId: MEETING_ID,
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

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([TASK]);
    findMany.mockReset().mockResolvedValue([TASK]);
    findUnique.mockReset().mockResolvedValue(TASK);
  });

  describe('search', () => {
    it('answers with the rows the statement found', async () => {
      await expect(tasks.search('launch emails')).resolves.toEqual([TASK]);
    });

    it('binds the text, trimmed, and the limit — never as part of the statement', async () => {
      await tasks.search('  launch emails ');

      expect(boundValues()[1]).toBe('launch emails');
      expect(boundValues().at(-1)).toBe(TASK_SEARCH_LIMIT);
      expect(boundValues().filter((value) => value === 'launch emails')).toHaveLength(4);
    });

    it('binds the meeting it is narrowed to, and nothing in its place when it is not', async () => {
      const boundTo = (): string => JSON.stringify(boundValues());

      await tasks.search('launch emails', MEETING_ID);
      expect(boundTo()).toContain(MEETING_ID);

      queryRaw.mockClear();
      await tasks.search('launch emails');
      expect(boundTo()).not.toContain('source_meeting_id =');
    });

    it.each(['', '   ', '\n\t'])(
      'finds nothing for the blank text %j, without asking',
      async (text) => {
        await expect(tasks.search(text)).resolves.toEqual([]);

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

    it('binds the title as given, the meeting, and the status for both branches', async () => {
      await tasks.upsert({ title: ' Call Bob ', sourceMeetingId: MEETING_ID, status: 'DONE' });

      expect(boundValues().slice(0, 4)).toEqual([' Call Bob ', MEETING_ID, 'DONE', 'DONE']);
    });

    it('binds no status when none is given, so an existing task keeps its own', async () => {
      await tasks.upsert({ title: TASK.title, sourceMeetingId: MEETING_ID });

      expect(boundValues().slice(2, 4)).toEqual([null, null]);
    });

    it('throws rather than answer with nothing when the statement returns no row', async () => {
      queryRaw.mockResolvedValue([]);

      await expect(
        tasks.upsert({ title: TASK.title, sourceMeetingId: MEETING_ID }),
      ).rejects.toThrow('The task upsert returned no row');
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
    it("answers the meeting's open tasks, the oldest first, and no more than the limit", async () => {
      await expect(tasks.open(MEETING_ID)).resolves.toEqual([TASK]);

      // The whole argument: a status or a meeting dropped from it is every task, or everyone's.
      expect(findMany).toHaveBeenCalledWith({
        where: { sourceMeetingId: MEETING_ID, status: 'OPEN' },
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
