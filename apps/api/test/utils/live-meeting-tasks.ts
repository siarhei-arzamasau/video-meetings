import type { Task, TaskStatus } from '../../src/generated/prisma/client';
import type { UpsertTaskInput } from '../../src/modules/tasks/services/task.service';

export interface LiveTaskCall {
  method: 'search' | 'upsert';
  meetingId: string | undefined;
  /** The query of a search, or the title of an upsert. */
  text: string;
}

const OPEN: TaskStatus = 'OPEN';

/** The words of a title that carry it: lower-case, three letters or more, plural dropped. */
function wordsOf(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];

  return new Set(words.map((word) => word.replace(/s$/, '')));
}

/**
 * `TaskService` for the `test:live` specs: the tasks in memory, and a note of every call —
 * which is what holds the real model to the order it was told to work in. That suite has no
 * database, and what it is about is what the model does with the tools, not what Postgres
 * does with a statement; `test/tasks.e2e-spec.ts` is where that is.
 *
 * Its search is a stand-in for trigram similarity and no measure of it: two titles are
 * similar when half the words of the shorter one are words of the other.
 */
export class LiveMeetingTasks {
  readonly calls: LiveTaskCall[] = [];
  private readonly tasks: Task[] = [];

  search(query: string, sourceMeetingId?: string): Promise<Task[]> {
    this.calls.push({ method: 'search', meetingId: sourceMeetingId, text: query });
    const wanted = wordsOf(query);

    return Promise.resolve(
      this.tasks.filter((task) => {
        const held = wordsOf(task.title);
        const shared = [...wanted].filter((word) => held.has(word)).length;
        const ofMeeting = sourceMeetingId === undefined || task.sourceMeetingId === sourceMeetingId;

        return ofMeeting && shared > 0 && shared * 2 >= Math.min(wanted.size, held.size);
      }),
    );
  }

  upsert({ title, sourceMeetingId, status }: UpsertTaskInput): Promise<Task> {
    this.calls.push({ method: 'upsert', meetingId: sourceMeetingId, text: title });
    const existing = this.tasks.find(
      (task) => task.sourceMeetingId === sourceMeetingId && task.title === title,
    );

    if (existing !== undefined) {
      existing.status = status ?? existing.status;

      return Promise.resolve(existing);
    }

    const task: Task = {
      id: crypto.randomUUID(),
      title,
      sourceMeetingId,
      status: status ?? OPEN,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tasks.push(task);

    return Promise.resolve(task);
  }

  /** The meeting's tasks, in the order they were created. */
  of(meetingId: string): Task[] {
    return this.tasks.filter((task) => task.sourceMeetingId === meetingId);
  }

  /** The calls made for the meeting, in the order they were made. */
  callsFor(meetingId: string): LiveTaskCall[] {
    return this.calls.filter((call) => call.meetingId === meetingId);
  }
}
