import type { QueryBus } from '@nestjs/cqrs';

import type { AccessTokenVerifier } from '../../auth/services/access-token.verifier';
import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';
import { MEETING_ID } from '../meeting-tools.fixture';
import {
  MeetingToolsStdioAccess,
  MeetingToolsStdioAccessOutcome,
} from './meeting-tools-stdio.access';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCESS_TOKEN = 'header.payload.signature';

describe('MeetingToolsStdioAccess', () => {
  const subjectOf = jest.fn();
  const execute = jest.fn();
  let access: MeetingToolsStdioAccess;

  beforeEach(() => {
    subjectOf.mockReset().mockResolvedValue(USER_ID);
    execute.mockReset().mockResolvedValue({ id: MEETING_ID, hostId: USER_ID });
    access = new MeetingToolsStdioAccess(
      { subjectOf } as unknown as AccessTokenVerifier,
      { execute } as unknown as QueryBus,
    );
  });

  it('grants the user the token names the meeting they can see', async () => {
    // With who was let in: what a tool or a resource is handed as its requester.
    await expect(access.check(ACCESS_TOKEN, MEETING_ID)).resolves.toEqual({
      outcome: MeetingToolsStdioAccessOutcome.GRANTED,
      requester: { userId: USER_ID },
    });

    // The meetings module's own rule, asked for the token's user and the server's meeting.
    expect(subjectOf).toHaveBeenCalledWith(ACCESS_TOKEN);
    expect(execute).toHaveBeenCalledWith(new FindVisibleMeetingQuery(USER_ID, MEETING_ID));
  });

  it('refuses a token that does not verify, and looks no meeting up for it', async () => {
    subjectOf.mockResolvedValue(null);

    await expect(access.check(ACCESS_TOKEN, MEETING_ID)).resolves.toEqual({
      outcome: MeetingToolsStdioAccessOutcome.TOKEN_REFUSED,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('finds no meeting for a user who is not in it, or for one that does not exist', async () => {
    execute.mockResolvedValue(null);

    await expect(access.check(ACCESS_TOKEN, MEETING_ID)).resolves.toEqual({
      outcome: MeetingToolsStdioAccessOutcome.MEETING_NOT_FOUND,
    });
  });
});
