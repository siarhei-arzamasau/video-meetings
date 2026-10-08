import type { Logger } from '@nestjs/common';
import type { EventBus } from '@nestjs/cqrs';
import { MEETING_FILE_TRANSCRIPTION_FAILED_MESSAGE } from '@repo/shared';

import { MeetingFileChangedEvent } from '../../events/meeting-file-changed.event';
import { TranscriptionStatus } from '../../services/meeting-file-transcription-status';
import type {
  ClaimedTranscription,
  MeetingFileTranscriptionRepository,
} from '../../services/meeting-file-transcription.repository';
import { toMeetingFile, transcriptKeyOf } from '../../services/meeting-file.mapper';
import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import type { MeetingFileStorage } from '../../storage/meeting-file-storage';

const { QUEUED, TRANSCRIBING, TRANSCRIBED, FAILED } = TranscriptionStatus;

/**
 * The writing half of the transcription worker: how a claim ended, put on the row and then
 * announced. Constructed by the worker, as `MeetingFilePurger` is by the file worker.
 *
 * Every write is the repository's conditional one — the file still `ready`, the lease still
 * the one given — and **an edge is announced only on its `true` branch**. A write that
 * changed nothing lost a race with a delete or with another worker's claim: there is nothing
 * to tell a watching page, and whatever was produced is discarded.
 *
 * The published file is the claimed row plus what was just written, not a re-read, which
 * would answer with whatever a later writer has done since.
 */
export class TranscriptionOutcomeRecorder {
  constructor(
    private readonly transcriptions: MeetingFileTranscriptionRepository,
    private readonly storage: MeetingFileStorage,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

  /** `claimNext` committed this edge itself; the claim returning a row is its "one row changed". */
  claimed(claimed: ClaimedTranscription, startedAt: number): void {
    this.announce(claimed, claimed.previousTranscriptionStatus, TRANSCRIBING, {}, startedAt);
  }

  /**
   * The transcript first, then the row: a row that says transcribed never points at nothing.
   *
   * A transcript that cannot be written at all — a full disk, a volume gone read-only — is a
   * failed transcription, and is recorded as one in the generic sentence. Left to escape, it
   * kept the row `TRANSCRIBING` until the lease lapsed and the recording was transcribed from
   * scratch, twice more, to end the same way with "repeated attempts" for a reason.
   */
  async complete(
    claimed: ClaimedTranscription,
    lease: Date,
    text: string,
    startedAt: number,
  ): Promise<void> {
    const transcriptKey = transcriptKeyOf(claimed.storageKey);
    const patch = { transcriptKey };

    if (!(await this.store(claimed, transcriptKey, text))) {
      await this.fail(claimed, lease, MEETING_FILE_TRANSCRIPTION_FAILED_MESSAGE, startedAt);

      return;
    }

    if (await this.transcriptions.transition(claimed.id, TRANSCRIBING, TRANSCRIBED, patch, lease)) {
      this.logger.log(
        `File ${claimed.id} of meeting ${claimed.meetingId}: transcribed ${String(claimed.size)} bytes of ${claimed.contentType} into ${String(text.length)} characters in ${String(Date.now() - startedAt)}ms`,
      );
      this.announce(claimed, TRANSCRIBING, TRANSCRIBED, patch, startedAt);
    } else {
      this.lost(claimed, 'recorded as transcribed');
      await this.removeUnlessReclaimed(claimed.id, transcriptKey);
    }
  }

  /** Whether the transcript is on disk. The cause of a write that failed goes to the log. */
  private async store(
    claimed: ClaimedTranscription,
    transcriptKey: string,
    text: string,
  ): Promise<boolean> {
    try {
      await this.storage.writeText(transcriptKey, text);

      return true;
    } catch (error) {
      this.logger.error(
        `File ${claimed.id} of meeting ${claimed.meetingId}: the transcript could not be stored`,
        error instanceof Error ? error.stack : String(error),
      );

      return false;
    }
  }

  /**
   * What to do with a transcript whose row could not be written, which depends on why.
   *
   * **The file was deleted:** the purge may already have run, so the transcript just written
   * is one nothing else would ever remove. **The claim was taken over** — the lease lapsed and
   * another worker claimed the recording — and the file is still `ready`: the key is one per
   * recording, not one per claim, so by now it may hold what that worker recorded, and
   * removing it would leave a row that says transcribed pointing at nothing. It is left where
   * it is: that claim overwrites it, a retry does, or the purge removes it with the file.
   */
  private async removeUnlessReclaimed(fileId: string, transcriptKey: string): Promise<void> {
    if (!(await this.transcriptions.isFileReady(fileId))) {
      await this.storage.remove(transcriptKey);
    }
  }

  /** `reason` is fixed copy the worker chose; the cause was logged where it was caught. */
  async fail(
    claimed: ClaimedTranscription,
    lease: Date | null,
    reason: string,
    startedAt: number,
  ): Promise<void> {
    const patch = { transcriptionFailureReason: reason };

    if (await this.transcriptions.transition(claimed.id, TRANSCRIBING, FAILED, patch, lease)) {
      this.announce(claimed, TRANSCRIBING, FAILED, patch, startedAt);
    } else {
      this.lost(claimed, 'recorded as failed');
    }
  }

  /** Shutdown's way out: the claim goes back uncounted, for whichever process claims it next. */
  async release(claimed: ClaimedTranscription, lease: Date, startedAt: number): Promise<void> {
    if (await this.transcriptions.release(claimed.id, lease)) {
      this.announce(claimed, TRANSCRIBING, QUEUED, {}, startedAt);
    } else {
      this.lost(claimed, 'released');
    }
  }

  /** The claim was gone before there was anything to write, or by the time it was written. */
  lost(claimed: ClaimedTranscription, what: string): void {
    this.logger.warn(
      `File ${claimed.id} of meeting ${claimed.meetingId}: transcription not ${what} — the file was deleted or the claim's lease lapsed and was reclaimed mid-run; result discarded`,
    );
  }

  private announce(
    claimed: ClaimedTranscription,
    from: TranscriptionStatus,
    to: TranscriptionStatus,
    patch: Partial<MeetingFileRecord>,
    startedAt: number,
  ): void {
    const file = toMeetingFile({ ...claimed, ...patch, transcriptionStatus: to });

    this.logger.log(
      `File ${claimed.id} of meeting ${claimed.meetingId}: transcription ${from} -> ${to} in ${String(Date.now() - startedAt)}ms`,
    );
    this.events.publish(new MeetingFileChangedEvent(claimed.meetingId, file));
  }
}
