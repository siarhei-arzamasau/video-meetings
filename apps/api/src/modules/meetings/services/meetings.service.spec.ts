import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../prisma/prisma.service';
import { MeetingsService } from './meetings.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const GRACE_ID = '22222222-2222-4222-8222-222222222222';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

/** Hosted-or-attending: the whole read authorisation rule, asserted once per query. */
const VISIBLE_TO_USER = {
  OR: [{ hostId: USER_ID }, { participants: { some: { userId: USER_ID } } }],
};

const RECORD = {
  id: MEETING_ID,
  title: 'Engine review',
  status: 'scheduled' as const,
  hostId: USER_ID,
  scheduledAt: new Date('2026-08-01T10:00:00.000Z'),
  participants: [{ userId: GRACE_ID }],
};

const MEETING = {
  id: MEETING_ID,
  title: 'Engine review',
  status: 'scheduled',
  hostId: USER_ID,
  scheduledAt: '2026-08-01T10:00:00.000Z',
  participantIds: [GRACE_ID],
};

describe('MeetingsService', () => {
  const findMany = jest.fn();
  const findFirst = jest.fn();
  const count = jest.fn();
  let meetings: MeetingsService;

  beforeEach(async () => {
    findMany.mockReset().mockResolvedValue([RECORD]);
    findFirst.mockReset().mockResolvedValue(RECORD);
    count.mockReset().mockResolvedValue(1);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingsService,
        { provide: PrismaService, useValue: { meeting: { findMany, findFirst, count } } },
      ],
    }).compile();

    meetings = moduleRef.get(MeetingsService);
  });

  describe('findAll', () => {
    it('returns only the meetings the user hosts or attends', async () => {
      await meetings.findAll(USER_ID);

      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: VISIBLE_TO_USER }));
    });

    it('breaks ties on id so two meetings at one instant have a stable order', async () => {
      await meetings.findAll(USER_ID);

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }] }),
      );
    });

    it('maps every record to the wire shape', async () => {
      await expect(meetings.findAll(USER_ID)).resolves.toEqual([MEETING]);
    });

    it('returns an empty list rather than throwing when nothing matches', async () => {
      findMany.mockResolvedValue([]);

      await expect(meetings.findAll(USER_ID)).resolves.toEqual([]);
    });

    it('reads every meeting when no limit is asked for', async () => {
      await meetings.findAll(USER_ID);

      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: undefined }));
    });

    it('takes the first `limit` in the order asked for, breaking ties ascending either way', async () => {
      await meetings.findAll(USER_ID, { limit: 3, order: 'desc' });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: VISIBLE_TO_USER,
          orderBy: [{ scheduledAt: 'desc' }, { id: 'asc' }],
          take: 3,
        }),
      );
    });
  });

  describe('count', () => {
    it('counts by the same visibility rule, without reading a meeting', async () => {
      count.mockResolvedValue(7);

      await expect(meetings.count(USER_ID)).resolves.toBe(7);
      expect(count).toHaveBeenCalledWith({ where: VISIBLE_TO_USER });
      expect(findMany).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('scopes the lookup by id and by the same visibility rule', async () => {
      await meetings.findOne(USER_ID, MEETING_ID);

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: MEETING_ID, ...VISIBLE_TO_USER } }),
      );
    });

    it('returns the mapped meeting', async () => {
      await expect(meetings.findOne(USER_ID, MEETING_ID)).resolves.toEqual(MEETING);
    });

    it('throws the same 404 for another user’s meeting as for no meeting at all', async () => {
      // One query answers both cases, so a 403 for the second is not reachable — which is the
      // point: distinguishing them would confirm that a meeting exists at that id.
      findFirst.mockResolvedValue(null);

      await expect(meetings.findOne(USER_ID, MEETING_ID)).rejects.toThrow(
        new NotFoundException('Meeting not found'),
      );
    });
  });
});
