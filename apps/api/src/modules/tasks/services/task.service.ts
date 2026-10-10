import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client';
import type { Task, TaskStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TaskStatus as StoredTaskStatus } from '../../../generated/prisma/enums';
import { OPEN_TASKS_LIMIT, TASK_SEARCH_LIMIT } from '../task.constants';

export interface UpsertTaskInput {
  /** Stored as given: with the meeting it is the task's identity, so the caller normalises. */
  title: string;
  sourceMeetingId: string;
  /** Left out, a new task is `OPEN` and an existing one keeps the status it has. */
  status?: TaskStatus;
}

/** The columns of a task under the names the generated client gives them. */
const TASK_COLUMNS = Prisma.sql`
  id, title, source_meeting_id AS "sourceMeetingId", status,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

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
   * **Without `sourceMeetingId`, every task is searched, whoever asks.** Tasks come from
   * meetings only their members can see, so a caller that answers anybody with this narrows
   * it first — to one meeting here, or to the caller's meetings.
   */
  async search(query: string, sourceMeetingId?: string): Promise<Task[]> {
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
      WHERE (title % ${text} OR ${text} <% title) ${ofMeeting}
      ORDER BY
        GREATEST(similarity(title, ${text}), word_similarity(${text}, title)) DESC,
        created_at DESC,
        id ASC
      LIMIT ${TASK_SEARCH_LIMIT}
    `;
  }

  /**
   * The meeting's tasks that are still open, the oldest first — at most `OPEN_TASKS_LIMIT`.
   * A task marked `DONE` is not among them; `search` finds those too.
   */
  async open(sourceMeetingId: string): Promise<Task[]> {
    return this.prisma.task.findMany({
      where: { sourceMeetingId, status: StoredTaskStatus.OPEN },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: OPEN_TASKS_LIMIT,
    });
  }

  /**
   * The task of this id, or `null` — what a miss means is the caller's.
   *
   * **Whichever meeting it came out of, whoever asks.** An id is not a secret, so a caller
   * that answers anybody with this checks `sourceMeetingId` against a meeting its caller
   * may see before it answers. The id has to be a UUID: the column is one, and the client
   * raises on anything else rather than simply not matching.
   */
  async get(taskId: string): Promise<Task | null> {
    return this.prisma.task.findUnique({ where: { id: taskId } });
  }

  /**
   * Creates the meeting's task of this title, or updates the one it already has, and
   * answers with the row either way.
   *
   * **A status that is not given is not written**: a task the meeting stated again keeps
   * the status it reached, rather than going back to `OPEN`.
   *
   * A meeting that does not exist is the foreign key's error, thrown as it is — what that
   * means to a caller is the caller's to say.
   */
  async upsert({ title, sourceMeetingId, status }: UpsertTaskInput): Promise<Task> {
    const givenStatus = status ?? null;
    const [task] = await this.prisma.$queryRaw<Task[]>`
      INSERT INTO "tasks" (id, title, source_meeting_id, status, updated_at)
      VALUES (
        gen_random_uuid(),
        ${title},
        ${sourceMeetingId}::uuid,
        COALESCE(${givenStatus}::"task_status", 'OPEN'),
        now()
      )
      ON CONFLICT (source_meeting_id, title) DO UPDATE
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
