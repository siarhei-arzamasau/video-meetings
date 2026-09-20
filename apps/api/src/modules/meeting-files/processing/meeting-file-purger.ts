import type { Logger } from '@nestjs/common';

import type { MeetingFileUploadRecord } from '../services/meeting-file-upload.mapper';
import type { MeetingFileUploadRepository } from '../services/meeting-file-upload.repository';
import { thumbnailKeyOf, transcriptKeyOf } from '../services/meeting-file.mapper';
import type { MeetingFileRepository } from '../services/meeting-file.repository';
import type { ClaimedFile } from '../services/meeting-file.repository';
import type { MeetingFileStorage } from '../storage/meeting-file-storage';

/**
 * The delete half of the worker's work: the bytes of a soft-deleted file, and the chunk tree
 * of an expired or aborted upload session. Both are claimed by the worker like any other row,
 * which is why the attempt cap is the same one processing uses.
 *
 * Announcing stays with the worker — `announcePurged` is its one publisher — because a
 * subscriber must see the row reconstructed the same way whatever moved it.
 */
export class MeetingFilePurger {
  constructor(
    private readonly files: MeetingFileRepository,
    private readonly uploads: MeetingFileUploadRepository,
    private readonly storage: MeetingFileStorage,
    private readonly logger: Logger,
    private readonly maxAttempts: number,
    private readonly announcePurged: (claimed: ClaimedFile) => void,
  ) {}

  /**
   * Removes the object, the thumbnail and the transcript — by the keys the steps derive, not
   * only the ones on the row: a file deleted while it was processing can be purged before the
   * step has written the thumbnail, and the row never learns the key. `remove` is idempotent,
   * so a thumbnail that never existed costs one `rm -f`.
   *
   * A purge that keeps throwing (an object the process cannot unlink) is given up on after
   * `maxAttempts` claims like a processing row is, else the row is reclaimed every lease for
   * ever: it is marked purged and the keys logged at error level for an operator.
   */
  async purgeFile(claimed: ClaimedFile, startedAt: number): Promise<void> {
    if (claimed.attempts > this.maxAttempts) {
      this.logger.error(
        `File ${claimed.id} claimed ${String(claimed.attempts)} times for purge; marking it purged with objects possibly left at ${claimed.storageKey}, ${thumbnailKeyOf(claimed.storageKey)} and ${transcriptKeyOf(claimed.storageKey)}`,
      );
      await this.markPurged(claimed);

      return;
    }

    await this.storage.remove(claimed.storageKey);
    await this.storage.remove(thumbnailKeyOf(claimed.storageKey));
    await this.storage.remove(transcriptKeyOf(claimed.storageKey));
    await this.markPurged(claimed);
    this.logger.log(
      `File ${claimed.id} of meeting ${claimed.meetingId}: purged in ${String(Date.now() - startedAt)}ms`,
    );
  }

  /**
   * An expired or aborted session: remove its chunk tree, then mark it purged — in that
   * order, so a crash between the two leaves a row that is claimed again rather than chunks
   * nobody will ever collect. `removeTree` is idempotent, so the retry costs one `rm -rf`.
   *
   * Given up on after `maxAttempts` claims, as a file's purge is, with the directory logged
   * for an operator: a tree the process cannot remove must not be reclaimed every lease for
   * ever.
   */
  async purgeUpload(upload: MeetingFileUploadRecord): Promise<void> {
    const startedAt = Date.now();

    if (upload.attempts > this.maxAttempts) {
      this.logger.error(
        `Upload ${upload.id} claimed ${String(upload.attempts)} times for purge; marking it purged with chunks possibly left under uploads/${upload.id}`,
      );
      await this.uploads.markPurged(upload.id);

      return;
    }

    await this.storage.removeTree(upload.id);
    await this.uploads.markPurged(upload.id);
    this.logger.log(
      `Upload ${upload.id} of meeting ${upload.meetingId}: chunks purged in ${String(Date.now() - startedAt)}ms`,
    );
  }

  /** Marks the bytes gone, and announces it only if the row was still this worker's to purge. */
  private async markPurged(claimed: ClaimedFile): Promise<void> {
    if (await this.files.markPurged(claimed.id)) {
      // Still `deleted` — the purge is about the bytes, not the row's state. A subscriber
      // removes the file on this as it did on the delete, which is idempotent by construction.
      this.announcePurged(claimed);
    }
  }
}
