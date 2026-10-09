import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import { MeetingDigestAnnouncer } from '../../services/meeting-digest-announcer';
import { readMeetingDigestRevision } from '../../services/meeting-digest-revision';
import { MeetingDigestRepository } from '../../services/meeting-digest.repository';
import {
  MeetingDigestRevisionOutcome,
  ReviseMeetingDigestCommand,
} from '../revise-meeting-digest.command';

/**
 * A stored digest's summary and decisions, rewritten outside a generation: the one write
 * to a digest's content that is not a worker's under its claim.
 *
 * It answers with an outcome and never throws one: its caller is not a route, and a
 * meeting with no digest is something that caller says in its own words.
 *
 * **The setting is not asked about.** `MEETING_DIGEST_ENABLED` decides whether transcripts
 * are sent to Anthropic; this sends nothing anywhere, and a stored digest is served and
 * tidied with the setting off as it is.
 */
@CommandHandler(ReviseMeetingDigestCommand)
export class ReviseMeetingDigestHandler implements ICommandHandler<
  ReviseMeetingDigestCommand,
  MeetingDigestRevisionOutcome
> {
  private readonly logger = new Logger(ReviseMeetingDigestHandler.name);

  constructor(
    private readonly repository: MeetingDigestRepository,
    private readonly announcer: MeetingDigestAnnouncer,
  ) {}

  async execute({
    meetingId,
    summary,
    decisions,
  }: ReviseMeetingDigestCommand): Promise<MeetingDigestRevisionOutcome> {
    const reading = readMeetingDigestRevision({ summary, decisions });

    if ('problem' in reading) {
      // The problem names a path and a rule and quotes nothing, as an answer's does.
      this.logger.warn(
        `Digest of meeting ${meetingId}: a revision was refused; ${reading.problem}`,
      );

      return MeetingDigestRevisionOutcome.UNFIT;
    }

    if (!(await this.repository.revise(meetingId, reading.revision))) {
      return MeetingDigestRevisionOutcome.NO_DIGEST;
    }

    this.logger.log(`Digest of meeting ${meetingId}: summary and decisions revised`);
    // After the write and never before it, as every writer here does.
    await this.announcer.announce(meetingId);

    return MeetingDigestRevisionOutcome.REVISED;
  }
}
