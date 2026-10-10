import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client';
import type { Task, TaskStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TaskStatus as StoredTaskStatus } from '../../../generated/prisma/enums';
import { MAX_TASKS_PER_OWNER, OPEN_TASKS_LIMIT, TASK_SEARCH_LIMIT } from '../task.constants';

export interface UpsertTaskInput {
  /**
   * Stored as given: with the meeting and the owner it is the task's identity, so the
   * caller normalises.
   */
  title: string;
  sourceMeetingId: string;
  /**
   * Whose task it is. **Who the caller is answering, never something they were sent**: a
   * task is found by its owner, so an owner taken from an argument is a write to somebody
   * else's task. Left out, the task is nobody's — what a digest's generation writes.
   */
  ownerId?: string;
  /** Left out, a new task is `OPEN` and an existing one keeps the status it has. */
  status?: TaskStatus;
}

/**
 * Thrown by `upsert` for a task that would be one more than `MAX_TASKS_PER_OWNER`. A class
 * of its own so that a caller can say so in its own words: it is a refusal, not a failure.
 */
export class TaskLimitReachedError extends Error {
  constructor() {
    super(`An owner may have at most ${MAX_TASKS_PER_OWNER} tasks in a meeting`);
    this.name = TaskLimitReachedError.name;
  }
}

/** The columns of a task under the names the generated client gives them. */
const TASK_COLUMNS = Prisma.sql`
  id, title, source_meeting_id AS "sourceMeetingId", owner_id AS "ownerId", status,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

/**
 * Tasks: the things to be done that came out of meetings, each a record of its own.
 *
 * The search and the upsert are raw SQL. The search is trigram similarity, which the client
 * has no word for, and the upsert is one `INSERT ... ON CONFLICT`, so two of them for one
 * task cannot both insert. The two plain reads go through the client.
 *
 * **What a reader may see is one rule, stated in each read: the tasks nobody owns, which
 * are the meeting's, and the reader's own.** Never another user's.
 */
@Injectable()
export class TaskService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The tasks whose title is similar to the text, the most similar first — at most
   * `TASK_SEARCH_LIMIT` of them, and none for a blank text.
   *
   * Similar means either of two things `pg_trgm` measures over the letters, whatever their
   * case: the title as a whole resembles the text (`%`), which is what finds a task worded
   * slightly differently, or some stretch of the title resembles it (`<%`), which is what
   * finds a task by a word or two of it. The thresholds are Postgres' own defaults, 0.3 and
   * 0.6.
   *
   * **Of one meeting, and of what one reader may see there — both said by every caller.**
   * `readerId: null` is a reader who is no user, which a digest's generation is: it sees
   * the tasks nobody owns and no user's, because what it finds can reach a whole meeting.
   * There is no way to ask for everybody's tasks, so no caller can do it by leaving
   * something out.
   */
  async search(query: string, sourceMeetingId: string, readerId: string | null): Promise<Task[]> {
    const text = query.trim();

    if (text === '') {
      return [];
    }

    // A null reader is equal to nothing, which leaves the tasks nobody owns.
    return this.prisma.$queryRaw<Task[]>`
      SELECT ${TASK_COLUMNS}
      FROM "tasks"
      WHERE (title % ${text} OR ${text} <% title)
        AND source_meeting_id = ${sourceMeetingId}::uuid
        AND (owner_id IS NULL OR owner_id = ${readerId}::uuid)
      ORDER BY
        GREATEST(similarity(title, ${text}), word_similarity(${text}, title)) DESC,
        created_at DESC,
        id ASC
      LIMIT ${TASK_SEARCH_LIMIT}
    `;
  }

  /**
   * The tasks of the meeting a reader may see that are still open, the oldest first — at
   * most `OPEN_TASKS_LIMIT`. A task marked `DONE` is not among them; `search` finds those
   * too.
   */
  async open(sourceMeetingId: string, readerId: string): Promise<Task[]> {
    return this.prisma.task.findMany({
      where: {
        sourceMeetingId,
        status: StoredTaskStatus.OPEN,
        OR: [{ ownerId: null }, { ownerId: readerId }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: OPEN_TASKS_LIMIT,
    });
  }

  /**
   * The task of this id, or `null` — what a miss means is the caller's.
   *
   * **Whichever meeting it came out of, whoever owns it, whoever asks.** An id says which
   * task to look for and is no permission to see it, so a caller that answers a user with
   * this checks `sourceMeetingId` against a meeting they may see, and that `ownerId` is
   * nobody or them, before it answers. The id has to be a UUID: the column is one, and the
   * client raises on anything else rather than simply not matching.
   */
  async get(taskId: string): Promise<Task | null> {
    return this.prisma.task.findUnique({ where: { id: taskId } });
  }

  /**
   * Creates the owner's task of this title in the meeting, or updates the one they already
   * have there, and answers with the row either way. **Another owner's task of the same
   * title is another task**, so no upsert reaches a task that is not its owner's — and one
   * with no owner reaches only the tasks nobody owns.
   *
   * **A status that is not given is not written**: a task the meeting stated again keeps
   * the status it reached, rather than going back to `OPEN`.
   *
   * **A task that would be the owner's `MAX_TASKS_PER_OWNER + 1`th in the meeting is not
   * written**, and `TaskLimitReachedError` is thrown; one that already exists is updated
   * whatever the count. The count and the insert are one statement and not one lock, so
   * writes made at the same moment can each pass under the limit: a bound to within a few.
   *
   * A meeting that does not exist is the foreign key's error, thrown as it is — what that
   * means to a caller is the caller's to say.
   */
  async upsert({ title, sourceMeetingId, ownerId, status }: UpsertTaskInput): Promise<Task> {
    const givenStatus = status ?? null;
    const owner = ownerId ?? null;
    const ownTasks = Prisma.sql`
      SELECT 1 FROM "tasks"
      WHERE source_meeting_id = ${sourceMeetingId}::uuid
        AND owner_id IS NOT DISTINCT FROM ${owner}::uuid
    `;
    // Nothing is selected to insert for a task that is new and one too many; one that
    // exists goes on to the conflict, and is updated however many there are. The index is
    // `NULLS NOT DISTINCT`, so a task nobody owns conflicts with itself too.
    const [task] = await this.prisma.$queryRaw<Task[]>`
      INSERT INTO "tasks" (id, title, source_meeting_id, owner_id, status, updated_at)
      SELECT
        gen_random_uuid(),
        ${title},
        ${sourceMeetingId}::uuid,
        ${owner}::uuid,
        COALESCE(${givenStatus}::"task_status", 'OPEN'),
        now()
      WHERE EXISTS (${ownTasks} AND title = ${title})
        OR (SELECT count(*) FROM (${ownTasks}) AS own_tasks) < ${MAX_TASKS_PER_OWNER}
      ON CONFLICT (source_meeting_id, owner_id, title) DO UPDATE
      SET status = COALESCE(${givenStatus}::"task_status", "tasks".status), updated_at = now()
      RETURNING ${TASK_COLUMNS}
    `;

    if (task === undefined) {
      // `DO UPDATE` returns the row whether it was inserted or updated, so no row is the
      // one case the statement leaves out: nothing was selected to insert.
      throw new TaskLimitReachedError();
    }

    return task;
  }
}
