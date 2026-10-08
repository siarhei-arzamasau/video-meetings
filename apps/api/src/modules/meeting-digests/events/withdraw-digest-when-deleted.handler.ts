import { Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';

import { MeetingFileChangedEvent } from '../../meeting-files/events/meeting-file-changed.event';
import { MeetingDigestDeleteFollower } from '../services/meeting-digest-delete-follower';
import { PendingDigestRequests } from '../services/pending-digest-requests';

/**
 * Makes a meeting's digest follow a deleted file: what was built from it is removed, and
 * either a replacement is asked for — while `MEETING_DIGEST_ENABLED` is on and a transcribed
 * recording is left — or the meeting has no digest. What exactly, case by case, is
 * `digestAfterDelete`.
 *
 * **This is tidying, and the read does not depend on it.** `GET` withholds a digest whose
 * recording is gone from the moment the delete commits, whether or not this has run; what
 * this adds is that the words leave the tables, that a replacement is generated without
 * anyone asking, and that open pages are told. So a reaction that fails is logged and not
 * retried — the next delete in the meeting catches up with it — and the setting is asked
 * for only to decide about the replacement: a delete withdraws with it off.
 *
 * **Every `deleted` is listened to, not only a recording's.** The event carries the file as
 * its delete read it, and a transcription that finished in that moment is not in it; which
 * recordings the digest was built from is this module's to know, and it asks itself. A
 * meeting with no digest row costs one indexed read and nothing else.
 *
 * **The one thing taken from the event is whether the file had a transcription status at
 * all**, which is what it cannot have wrong: a file is given one by the write that makes it
 * `ready`, and the delete is conditional on the status it read, so a file read without one
 * was deleted without one. *Which* status is another matter — "transcribing" in the event
 * may have been "transcribed" by the time the delete landed, and the digest made out of
 * date by it. So any recording's delete may have taken the out-of-date mark with it, and is
 * followed as one that did: the price is a version moved for nothing when it had not.
 *
 * **The purge announces `deleted` a second time, and nothing tells the two apart.** Content
 * removed the first time is not there to remove again, and a status cleared is not cleared
 * twice. The one repeat is `CURRENT_AGAIN`, whose only write is the version: a digest that
 * was not built from the recording has its version moved once more, and an open page is
 * sent the digest it already holds.
 */
@EventsHandler(MeetingFileChangedEvent)
export class WithdrawDigestWhenDeletedHandler implements IEventHandler<MeetingFileChangedEvent> {
  private readonly logger = new Logger(WithdrawDigestWhenDeletedHandler.name);

  constructor(
    private readonly deletes: MeetingDigestDeleteFollower,
    private readonly pending: PendingDigestRequests,
  ) {}

  /** Synchronous up to the registration, for `RequestDigestWhenTranscribedHandler`'s reason. */
  handle({ meetingId, file }: MeetingFileChangedEvent): void {
    if (file.status !== 'deleted') {
      return;
    }

    this.pending.track(this.follow(meetingId, file));
  }

  /**
   * Never rejects: nobody awaits it but shutdown and `drain()`. The decision, the write, and
   * the announcement of a write are `MeetingDigestDeleteFollower.follow`'s.
   */
  private async follow(meetingId: string, file: MeetingFile): Promise<void> {
    try {
      await this.deletes.follow(meetingId, {
        recordingDeleted: file.transcriptionStatus !== undefined,
        because: `file ${file.id} was deleted`,
      });
    } catch (error) {
      this.logger.error(
        `Digest of meeting ${meetingId}: following the delete of file ${file.id} failed; the read still withholds what was built from it`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
