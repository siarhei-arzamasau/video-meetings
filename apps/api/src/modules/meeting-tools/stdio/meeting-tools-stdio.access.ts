import { Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { AccessTokenVerifier } from '../../auth/services/access-token.verifier';
import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';
import type { VisibleMeeting } from '../../meetings/queries/find-visible-meeting.query';

/** What a check of the client's token against the server's meeting comes to. */
export enum MeetingToolsStdioAccessOutcome {
  GRANTED = 'GRANTED',
  TOKEN_REFUSED = 'TOKEN_REFUSED',
  MEETING_NOT_FOUND = 'MEETING_NOT_FOUND',
}

export type MeetingToolsStdioRefusal = Exclude<
  MeetingToolsStdioAccessOutcome,
  MeetingToolsStdioAccessOutcome.GRANTED
>;

/**
 * Who a server is answering: the user its client's token names. What a tool or a resource
 * is handed once that user has been let in, for a rule about them that is finer than "may
 * read the meeting" — there is none yet, a task having no assignee.
 */
export interface MeetingToolsRequester {
  userId: string;
}

/** The outcome of a check, with the requester it let in. */
export type MeetingToolsStdioAdmission =
  | { outcome: MeetingToolsStdioAccessOutcome.GRANTED; requester: MeetingToolsRequester }
  | { outcome: MeetingToolsStdioRefusal };

/**
 * What a refused client is told, on stderr as the process declines to start and as a tool's
 * error once it is up. A meeting that does not exist and one the user is not in are one
 * sentence, as they are one 404 on a route: which of the two it was is not the caller's to
 * learn.
 */
export const MEETING_TOOLS_STDIO_REFUSALS: Record<MeetingToolsStdioRefusal, string> = {
  [MeetingToolsStdioAccessOutcome.TOKEN_REFUSED]:
    'The access token was refused: it is not one this API signed, or it has expired. Sign in again and start the server with the new token.',
  [MeetingToolsStdioAccessOutcome.MEETING_NOT_FOUND]:
    'There is no such meeting for the user the access token names.',
};

/**
 * Whether the user a client's access token names may read the meeting its server was
 * started for — the API's own two rules, asked of their owners: `auth` verifies the token
 * as `JwtAuthGuard` has it verified, and `meetings` answers by `visibleTo`, the rule that
 * shows a meeting, its files and its digest to its host and its participants.
 *
 * **No lookup of the user.** The guard makes one so that a token cannot outlive its
 * account; here the meeting's own row does that, since a user who is gone hosts and attends
 * nothing.
 */
@Injectable()
export class MeetingToolsStdioAccess {
  constructor(
    private readonly tokens: AccessTokenVerifier,
    private readonly queryBus: QueryBus,
  ) {}

  /** Decided now, on every call: the token may have expired since, or the meeting gone. */
  async check(accessToken: string, meetingId: string): Promise<MeetingToolsStdioAdmission> {
    const userId = await this.tokens.subjectOf(accessToken);

    if (userId === null) {
      return { outcome: MeetingToolsStdioAccessOutcome.TOKEN_REFUSED };
    }

    const meeting = await this.queryBus.execute<FindVisibleMeetingQuery, VisibleMeeting | null>(
      new FindVisibleMeetingQuery(userId, meetingId),
    );

    return meeting === null
      ? { outcome: MeetingToolsStdioAccessOutcome.MEETING_NOT_FOUND }
      : { outcome: MeetingToolsStdioAccessOutcome.GRANTED, requester: { userId } };
  }
}
