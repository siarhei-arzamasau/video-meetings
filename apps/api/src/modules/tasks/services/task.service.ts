import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client';
import type { Task, TaskStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TaskStatus as StoredTaskStatus } from '../../../generated/prisma/enums';
import { OPEN_TASKS_LIMIT, TASK_SEARCH_LIMIT } from '../task.constants';

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

/** The columns of a task under the names the generated client gives them. */
const TASK_COLUMNS = Prisma.sql`
  id, title, source_meeting_id AS "sourceMeetingId", owner_id AS "ownerId", status,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

/** The condition a search is narrowed to an owner by: one user, nobody, or not at all. */
function ownedBy(ownerId: string | null | undefined): Prisma.Sql {
  if (ownerId === undefined) {
    return Prisma.empty;
  }

  return ownerId === null
    ? Prisma.sql`AND owner_id IS NULL`
    : Prisma.sql`AND owner_id = ${ownerId}::uuid`;
}

/**
 * Tasks: the things to be done that came out of meetings, each a record of its own.
 *
 * The search and the upsert are raw SQL. The search is trigram similarity, which the client
 * has no word for, and the upsert is one `INSERT ... ON CONFLICT`, so two of them for one
 * task cannot both insert. The two plain reads go through the client.
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
   * **Without `sourceMeetingId`, every task is searched, whoever asks, and without
   * `ownerId` everybody's.** Tasks come from meetings only their members can see, and a
   * task with an owner is that user's alone: a caller that answers a user with this narrows
   * it to both first. `ownerId: null` is the tasks nobody owns, which is what a digest's
   * generation searches: it answers no user, and what it finds reaches a whole meeting.
   */
  async search(query: string, sourceMeetingId?: string, ownerId?: string | null): Promise<Task[]> {
    const text = query.trim();

    if (text === '') {
      return [];
    }

    const ofMeeting =
      sourceMeetingId === undefined
        ? Prisma.empty
        : Prisma.sql`AND source_meeting_id = ${sourceMeetingId}::uuid`;
    return this.prisma.$queryRaw<Task[]>`
      SELECT ${TASK_COLUMNS}
      FROM "tasks"
      WHERE (title % ${text} OR ${text} <% title) ${ofMeeting} ${ownedBy(ownerId)}
      ORDER BY
        GREATEST(similarity(title, ${text}), word_similarity(${text}, title)) DESC,
        created_at DESC,
        id ASC
      LIMIT ${TASK_SEARCH_LIMIT}
    `;
  }

  /**
   * The owner's tasks of the meeting that are still open, the oldest first — at most
   * `OPEN_TASKS_LIMIT`. A task marked `DONE` is not among them; `search` finds those too.
   * Nobody else's task is, and none that nobody owns.
   */
  async open(sourceMeetingId: string, ownerId: string): Promise<Task[]> {
    return this.prisma.task.findMany({
      where: { sourceMeetingId, ownerId, status: StoredTaskStatus.OPEN },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: OPEN_TASKS_LIMIT,
    });
  }

  /**
   * The task of this id, or `null` — what a miss means is the caller's.
   *
   * **Whichever meeting it came out of, whoever owns it, whoever asks.** An id says which
   * task to look for and is no permission to see it, so a caller that answers a user with
   * this checks `sourceMeetingId` against a meeting they may see and `ownerId` against who
   * they are before it answers. The id has to be a UUID: the column is one, and the client
   * raises on anything else rather than simply not matching.
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
   * A meeting that does not exist is the foreign key's error, thrown as it is — what that
   * means to a caller is the caller's to say.
   */
  async upsert({ title, sourceMeetingId, ownerId, status }: UpsertTaskInput): Promise<Task> {
    const givenStatus = status ?? null;
    // The index is `NULLS NOT DISTINCT`, so a task nobody owns conflicts with itself too.
    const [task] = await this.prisma.$queryRaw<Task[]>`
      INSERT INTO "tasks" (id, title, source_meeting_id, owner_id, status, updated_at)
      VALUES (
        gen_random_uuid(),
        ${title},
        ${sourceMeetingId}::uuid,
        ${ownerId ?? null}::uuid,
        COALESCE(${givenStatus}::"task_status", 'OPEN'),
        now()
      )
      ON CONFLICT (source_meeting_id, owner_id, title) DO UPDATE
      SET status = COALESCE(${givenStatus}::"task_status", "tasks".status), updated_at = now()
      RETURNING ${TASK_COLUMNS}
    `;

    if (task === undefined) {
      // `DO UPDATE` returns the row whether it was inserted or updated, so this is a
      // statement that has stopped being that one, not a task that is missing.
      throw new Error('The task upsert returned no row');
    }

    return task;
  }
}
