import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryBus } from '@nestjs/cqrs';

import { FindTranscribedRecordingsQuery } from '../../meeting-files/queries/find-transcribed-recordings.query';
import type { TranscribedRecording } from '../../meeting-files/queries/find-transcribed-recordings.query';
import { MeetingDigestAnnouncer } from './meeting-digest-announcer';
import { DigestAfterDelete } from './meeting-digest-writes';
import { MeetingDigestRepository } from './meeting-digest.repository';

/** What each outcome is logged as. A `Record`, so an outcome added without its line does not compile. */
const LOGGED_AS: Record<DigestAfterDelete, string> = {
  [DigestAfterDelete.UNCHANGED]: 'unchanged',
  [DigestAfterDelete.CURRENT_AGAIN]: 'kept, and no longer out of date',
  [DigestAfterDelete.REPLACING]: 'content removed, and a replacement requested',
  [DigestAfterDelete.CLEARED]: 'content removed and status cleared: there is no digest',
  [DigestAfterDelete.WITHDRAWN]: 'content removed; the status is a later request’s',
};

/** What a caller of `follow` knows about the delete it is following. */
export interface FollowedDelete {
  /**
   * Whether a recording was deleted that may have been the only one the digest did not
   * cover — what `RecordingsAfterDelete.recordingDeleted` is for.
   */
  recordingDeleted: boolean;
  /** What happened, for the log line: "file … was deleted". */
  because: string;
}

/**
 * Makes a meeting's digest follow the recordings deleted from it, for the two callers that
 * can find one gone: the handler of a file's `deleted` event, and the worker, looking once
 * more at the recordings of an answer it has just stored.
 *
 * One place for both because the order of its three steps is the whole of its correctness,
 * and two copies would one day disagree about it.
 */
@Injectable()
export class MeetingDigestDeleteFollower {
  private readonly logger = new Logger(MeetingDigestDeleteFollower.name);

  constructor(
    private readonly config: ConfigService,
    private readonly queryBus: QueryBus,
    private readonly digests: MeetingDigestRepository,
    private readonly announcer: MeetingDigestAnnouncer,
  ) {}

  /**
   * Decides and writes what the recordings deleted so far do to the digest, announces a
   * write, and answers with what was done. Rejects when a read or the write fails; the
   * caller logs, and nothing was announced.
   *
   * **The revision first, the recordings second, the write third — and the order is the
   * point.** A recording transcribed after the recordings were read is not among them, and
   * its request moves the revision; the write sees that it moved and leaves the status that
   * request made. Read the other way round, a meeting whose last recording was deleted as
   * another was transcribed would be cleared with a recording in it and nothing queued.
   *
   * The setting is asked for only to decide about a replacement: a delete withdraws with it
   * off. A meeting with no digest row costs one indexed read and nothing else.
   */
  async follow(
    meetingId: string,
    { recordingDeleted, because }: FollowedDelete,
  ): Promise<DigestAfterDelete> {
    const requestedRevision = await this.digests.findRevisionOf(meetingId);

    if (requestedRevision === null) {
      return DigestAfterDelete.UNCHANGED;
    }

    const outcome = await this.digests.followDelete({
      meetingId,
      requestedRevision,
      transcribedFileIds: await this.transcribedIdsOf(meetingId),
      replace: this.config.get<boolean>('MEETING_DIGEST_ENABLED', false),
      recordingDeleted,
    });

    if (outcome !== DigestAfterDelete.UNCHANGED) {
      this.logger.log(`Digest of meeting ${meetingId}: ${LOGGED_AS[outcome]}, ${because}`);
      await this.announcer.announce(meetingId);
    }

    return outcome;
  }

  /**
   * The worker's second look, **after** the answer built from `sourceFileIds` was stored:
   * if one of those recordings is no longer transcribed, the digest follows its delete here.
   *
   * The look before the write cannot be the only one. A delete that commits just after it
   * can be followed before the answer lands: that reaction finds none of the new sources,
   * changes nothing, and the answer is then stored with a deleted recording in it and
   * nothing queued — withheld by the read, and with no digest of the recordings that are
   * left until some later delete or transcription in the meeting. With this look, one of the
   * two always sees the other: a delete that committed before it is found missing here, and
   * one that commits after it has its own reaction lock the row after the answer was stored.
   *
   * Never rejects: the answer is stored, and the read withholds it either way.
   */
  async recheckStored(meetingId: string, sourceFileIds: ReadonlyArray<string>): Promise<void> {
    try {
      const transcribed = new Set(await this.transcribedIdsOf(meetingId));

      if (sourceFileIds.every((fileId) => transcribed.has(fileId))) {
        return;
      }

      // Not `recordingDeleted`: whether the out-of-date mark moved is the delete's own
      // reaction's to say, and this one has content to remove or nothing to do.
      await this.follow(meetingId, {
        recordingDeleted: false,
        because: 'a recording it was built from was deleted as it was stored',
      });
    } catch (error) {
      this.logger.error(
        `Digest of meeting ${meetingId}: its recordings could not be checked after it was stored; the read withholds what a deleted one said`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async transcribedIdsOf(meetingId: string): Promise<string[]> {
    const recordings = await this.queryBus.execute<
      FindTranscribedRecordingsQuery,
      TranscribedRecording[]
    >(new FindTranscribedRecordingsQuery(meetingId));

    return recordings.map(({ id }) => id);
  }
}
