import type { MeetingFile } from '@repo/shared';

/**
 * A meeting file reached a new state, and the row is already committed.
 *
 * Published on the in-process `EventBus` by the worker after every transition it makes and
 * every purge, and by the upload, delete, and retry handlers after their writes — nowhere
 * else. One publisher per write is what lets a reader trust that an event it did not see
 * never happened; see the API guide's "one publisher" rule.
 *
 * Carries the whole `MeetingFile`, not a diff: `MeetingFile` has no version field, so a
 * subscriber applies an event by replacing the row with this id. A missed event is therefore
 * harmless — the next full list, which every reconnect fetches, is the repair.
 *
 * `file.status` is `deleted` for both the soft delete and the purge that follows it. A
 * subscriber removes the row on either, which is idempotent by construction.
 */
export class MeetingFileChangedEvent {
  constructor(
    readonly meetingId: string,
    readonly file: MeetingFile,
  ) {}
}
