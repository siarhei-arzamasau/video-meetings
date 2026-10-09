import { Injectable, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';

import { describeError } from '../../../common/error-message';
import { MeetingDigestChangedEvent } from '../events/meeting-digest-changed.event';
import { MeetingDigestsService } from './meeting-digests.service';

/**
 * The one publisher of `MeetingDigestChangedEvent`: whoever has just committed a write to a
 * digest calls `announce`, after the write and never before it.
 *
 * **It reads the digest again rather than being handed one.** What the event carries is what
 * `GET` answers, and that is the row, its three tables, and the recordings transcribed now —
 * more than any writer holds. So the event is a snapshot taken after the write: at least as
 * new as it, possibly newer, and always whole. Two writes close together may be announced
 * as the same snapshot twice; a client that keeps the higher version takes the second as
 * nothing new.
 */
@Injectable()
export class MeetingDigestAnnouncer {
  private readonly logger = new Logger(MeetingDigestAnnouncer.name);

  constructor(
    private readonly digests: MeetingDigestsService,
    private readonly events: EventBus,
  ) {}

  /**
   * Never rejects. The write it follows is committed and stays so: a read that fails here
   * costs the open pages one event, which the fetch they make when their stream next opens
   * repairs — and must not fail a generation, or undo a request.
   */
  async announce(meetingId: string): Promise<void> {
    try {
      const digest = await this.digests.currentOf(meetingId);

      this.events.publish(new MeetingDigestChangedEvent(meetingId, digest));
    } catch (error) {
      this.logger.error(
        `Digest of meeting ${meetingId}: a change could not be announced; open pages have it at their next fetch`,
        describeError(error),
      );
    }
  }
}
