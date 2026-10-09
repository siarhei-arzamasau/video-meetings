import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';

import { describeError } from '../../../common/error-message';
import { MeetingFileChangedEvent } from '../../meeting-files/events/meeting-file-changed.event';
import { MeetingDigestAnnouncer } from '../services/meeting-digest-announcer';
import { MeetingDigestRepository } from '../services/meeting-digest.repository';
import { PendingDigestRequests } from '../services/pending-digest-requests';

/**
 * A recording that has just been transcribed: the one event a file in this state is
 * announced with. Nothing else is ever published for a file that is `ready` and
 * `transcribed` — every later write to it is its delete, which makes it `deleted`.
 */
function isNewlyTranscribed(file: MeetingFile): boolean {
  return file.status === 'ready' && file.transcriptionStatus === 'transcribed';
}

/**
 * Asks for a meeting's digest every time one of its recordings reaches Transcribed, while
 * `MEETING_DIGEST_ENABLED` is on — the automatic generation, and its only trigger. A PDF, a
 * recording that failed, a delete: none of them is that event, and none asks for anything.
 *
 * **The trigger is the event, not the transcription's own transaction.** The request is a
 * second write, made after the first has committed, so a process killed between the two
 * leaves a transcribed recording with nothing queued — as does a request that fails here,
 * which is logged and not retried. That is exactly the state of a recording transcribed
 * while the setting was off, and the way out of it is the same: asking for the digest by
 * hand. Closing the window would mean `meeting-files` writing this module's table.
 *
 * The setting is asked for per event, not once in a constructor: off, a newly transcribed
 * recording asks for nothing, and nothing is generated for it when the setting comes back.
 *
 * **Off, it still tells a stored digest's readers about the recording.** Nothing is written
 * about the digest's status, but one that exists no longer covers every recording, so what
 * `GET` answers changed — `outOfDate` — and the version moves with it so that an open page
 * takes the announcement over what it holds. A meeting with no stored digest has nothing
 * that changed, and nothing is written or announced for it.
 */
@EventsHandler(MeetingFileChangedEvent)
export class RequestDigestWhenTranscribedHandler implements IEventHandler<MeetingFileChangedEvent> {
  private readonly logger = new Logger(RequestDigestWhenTranscribedHandler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly digests: MeetingDigestRepository,
    private readonly pending: PendingDigestRequests,
    private readonly announcer: MeetingDigestAnnouncer,
  ) {}

  /**
   * Synchronous up to the registration, and it has to be: the bus calls this inside
   * `publish`, so by the time the publisher's `publish` returns the request is one that
   * `PendingDigestRequests.settled()` waits for.
   */
  handle({ meetingId, file }: MeetingFileChangedEvent): void {
    if (!isNewlyTranscribed(file)) {
      return;
    }

    const enabled = this.config.get<boolean>('MEETING_DIGEST_ENABLED', false);

    this.pending.track(this.follow(meetingId, file.id, enabled));
  }

  /**
   * Never rejects: nobody awaits it but shutdown, which only needs it to have finished. The
   * announcement follows the write, and only a write: a recording that changed nothing a
   * client is shown is announced to nobody.
   */
  private async follow(meetingId: string, fileId: string, enabled: boolean): Promise<void> {
    try {
      if (enabled) {
        await this.digests.request(meetingId);
        this.logger.log(
          `Digest of meeting ${meetingId}: requested, file ${fileId} was transcribed`,
        );
      } else if (await this.digests.noteUncoveredRecording(meetingId)) {
        this.logger.log(
          `Digest of meeting ${meetingId}: out of date, file ${fileId} was transcribed with the digest off`,
        );
      } else {
        return;
      }
    } catch (error) {
      this.logger.error(
        `Digest of meeting ${meetingId}: the request after file ${fileId} was transcribed failed; nothing is queued`,
        describeError(error),
      );

      return;
    }

    await this.announcer.announce(meetingId);
  }
}
