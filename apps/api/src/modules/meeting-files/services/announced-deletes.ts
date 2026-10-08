import type { MeetingFile } from '@repo/shared';

/**
 * How many deleted files are remembered. A late event trails its delete by milliseconds, so
 * to get past this it would have to be overtaken by this many other deletes first.
 */
export const REMEMBERED_DELETES = 1_024;

/**
 * The files whose delete has been announced, so that nothing else is announced for them.
 *
 * `deleted` is terminal, and every other write is conditional on the row not being deleted.
 * An event for a file after its `deleted` can therefore only be an older state announced
 * late: a worker's write committed just before the delete did, and Node resumed the delete's
 * handler first. Nothing orders those two — neither proves the other came first, which is
 * why `MeetingFileHandOvers` leaves them alone — and a subscriber has no version to compare.
 * It takes an id it does not hold for somebody else's upload and puts the row back: a file
 * that is gone, with a transcript link that answers 404, until its next full list.
 *
 * Dropping the late event is right whichever order the two arrived in, which is what makes
 * this the one inversion that can be closed here without knowing the order of the writes.
 */
export class AnnouncedDeletes {
  /** Insertion-ordered, as a `Set` is: the first id is the one deleted longest ago. */
  private readonly fileIds = new Set<string>();

  /**
   * Whether the event is to be passed on. A `deleted` always is — the purge repeats it, and
   * a subscriber removes the row on either — and is remembered; anything else for a file
   * already remembered is not.
   */
  admits({ id, status }: Pick<MeetingFile, 'id' | 'status'>): boolean {
    if (status !== 'deleted') {
      return !this.fileIds.has(id);
    }

    // Taken out first, so the purge's repeat moves the id back among the newest.
    this.fileIds.delete(id);
    this.fileIds.add(id);

    if (this.fileIds.size > REMEMBERED_DELETES) {
      const [oldest] = this.fileIds;

      if (oldest !== undefined) {
        this.fileIds.delete(oldest);
      }
    }

    return true;
  }
}
