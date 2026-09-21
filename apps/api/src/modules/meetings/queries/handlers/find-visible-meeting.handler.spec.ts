import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { FindVisibleMeetingQuery } from '../find-visible-meeting.query';
import { FindVisibleMeetingHandler } from './find-visible-meeting.handler';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const PARTICIPANT_ID = '22222222-2222-4222-8222-222222222222';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

/** All the row Prisma returns under the handler's `select`. */
const VISIBLE = { id: MEETING_ID, hostId: HOST_ID };

describe('FindVisibleMeetingHandler', () => {
  const findFirst = jest.fn();
  let handler: FindVisibleMeetingHandler;

  beforeEach(async () => {
    findFirst.mockReset().mockResolvedValue(VISIBLE);

    const moduleRef = await Test.createTestingModule({
      providers: [
        FindVisibleMeetingHandler,
        { provide: PrismaService, useValue: { meeting: { findFirst } } },
      ],
    }).compile();

    handler = moduleRef.get(FindVisibleMeetingHandler);
  });

  it.each([
    ['the host', HOST_ID],
    ['a participant', PARTICIPANT_ID],
  ])('scopes the lookup by id and the visibility rule for %s', async (_who, userId) => {
    await expect(handler.execute(new FindVisibleMeetingQuery(userId, MEETING_ID))).resolves.toEqual(
      VISIBLE,
    );

    // The whole argument, so an `include` creeping back — the participants join this read
    // exists to avoid — fails here.
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: MEETING_ID,
        OR: [{ hostId: userId }, { participants: { some: { userId } } }],
      },
      select: { id: true, hostId: true },
    });
  });

  it('resolves to null for a stranger rather than throwing', async () => {
    // What a miss means is the caller's decision — the file routes turn it into a 404, and
    // the same 404 as for a meeting that does not exist, so nothing here may distinguish them.
    findFirst.mockResolvedValue(null);

    await expect(
      handler.execute(
        new FindVisibleMeetingQuery('33333333-3333-4333-8333-333333333333', MEETING_ID),
      ),
    ).resolves.toBeNull();
  });

  it('resolves to null for an unknown id', async () => {
    findFirst.mockResolvedValue(null);

    await expect(
      handler.execute(new FindVisibleMeetingQuery(HOST_ID, '55555555-5555-4555-8555-555555555555')),
    ).resolves.toBeNull();
  });
});
