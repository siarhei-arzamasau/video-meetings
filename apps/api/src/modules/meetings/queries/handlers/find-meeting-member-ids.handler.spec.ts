import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { FindMeetingMemberIdsQuery } from '../find-meeting-member-ids.query';
import { FindMeetingMemberIdsHandler } from './find-meeting-member-ids.handler';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const PARTICIPANT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTICIPANT_ID = '33333333-3333-4333-8333-333333333333';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

describe('FindMeetingMemberIdsHandler', () => {
  const findUnique = jest.fn();
  let handler: FindMeetingMemberIdsHandler;

  beforeEach(async () => {
    findUnique.mockReset().mockResolvedValue({
      hostId: HOST_ID,
      participants: [{ userId: PARTICIPANT_ID }, { userId: OTHER_PARTICIPANT_ID }],
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        FindMeetingMemberIdsHandler,
        { provide: PrismaService, useValue: { meeting: { findUnique } } },
      ],
    }).compile();

    handler = moduleRef.get(FindMeetingMemberIdsHandler);
  });

  it('answers the host and every participant, the host first', async () => {
    await expect(handler.execute(new FindMeetingMemberIdsQuery(MEETING_ID))).resolves.toEqual([
      HOST_ID,
      PARTICIPANT_ID,
      OTHER_PARTICIPANT_ID,
    ]);
  });

  it('reads ids only, of that meeting, with no rule about who is asking', async () => {
    await handler.execute(new FindMeetingMemberIdsQuery(MEETING_ID));

    // The whole argument: a title, a name, or an address selected here would cross the
    // boundary with the ids, and a visibility rule would need a user this query never has.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: MEETING_ID },
      select: { hostId: true, participants: { select: { userId: true } } },
    });
  });

  it('names a member once, even if a row lists the host among the participants', async () => {
    findUnique.mockResolvedValue({
      hostId: HOST_ID,
      participants: [{ userId: HOST_ID }, { userId: PARTICIPANT_ID }],
    });

    await expect(handler.execute(new FindMeetingMemberIdsQuery(MEETING_ID))).resolves.toEqual([
      HOST_ID,
      PARTICIPANT_ID,
    ]);
  });

  it('answers the host alone for a meeting with no participants', async () => {
    findUnique.mockResolvedValue({ hostId: HOST_ID, participants: [] });

    await expect(handler.execute(new FindMeetingMemberIdsQuery(MEETING_ID))).resolves.toEqual([
      HOST_ID,
    ]);
  });

  it('resolves to null for an unknown meeting rather than throwing', async () => {
    findUnique.mockResolvedValue(null);

    // What a miss means is the caller's: the digest worker reads it as "nobody to link to".
    await expect(handler.execute(new FindMeetingMemberIdsQuery(MEETING_ID))).resolves.toBeNull();
  });
});
