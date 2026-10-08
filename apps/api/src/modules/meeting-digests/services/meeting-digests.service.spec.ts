import { NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { FindTranscribedRecordingsQuery } from '../../meeting-files/queries/find-transcribed-recordings.query';
import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';
import {
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
  buildMeetingDigestRecord,
} from './meeting-digest-record.fixture';
import { DigestStatus } from './meeting-digest-status';
import { MeetingDigestRepository } from './meeting-digest.repository';
import { MeetingDigestsService } from './meeting-digests.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING = { id: DIGEST_MEETING_ID, hostId: USER_ID };

describe('MeetingDigestsService', () => {
  const findOf = jest.fn();
  /** What each query the service dispatches is answered with, by its class. */
  let visibleMeeting: typeof MEETING | null;
  let transcribed: Array<{ id: string; uploaderId: string }>;
  const execute = jest.fn();
  let service: MeetingDigestsService;

  const dispatched = (): unknown[] => execute.mock.calls.map(([query]: [unknown]) => query);

  beforeEach(async () => {
    visibleMeeting = MEETING;
    transcribed = [{ id: FIRST_RECORDING_ID, uploaderId: USER_ID }];
    execute.mockReset().mockImplementation(async (query: unknown) => {
      if (query instanceof FindVisibleMeetingQuery) {
        return visibleMeeting;
      }
      if (query instanceof FindTranscribedRecordingsQuery) {
        return transcribed;
      }

      throw new Error('An unexpected query was dispatched');
    });
    findOf.mockReset().mockResolvedValue(buildMeetingDigestRecord());

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingDigestsService,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingDigestRepository, useValue: { findOf } },
      ],
    }).compile();

    service = moduleRef.get(MeetingDigestsService);
  });

  it('answers the stored digest of a meeting the caller can see', async () => {
    const digest = await service.findOne(USER_ID, DIGEST_MEETING_ID);

    expect(findOf).toHaveBeenCalledWith(DIGEST_MEETING_ID);
    expect(digest).toMatchObject({
      meetingId: DIGEST_MEETING_ID,
      version: 3,
      status: 'ready',
      content: { outOfDate: false },
    });
  });

  it('answers 404 for a meeting the caller cannot see, before any digest is read', async () => {
    visibleMeeting = null;

    await expect(service.findOne(USER_ID, DIGEST_MEETING_ID)).rejects.toThrow(
      new NotFoundException('Meeting not found'),
    );

    expect(dispatched()).toEqual([new FindVisibleMeetingQuery(USER_ID, DIGEST_MEETING_ID)]);
    expect(findOf).not.toHaveBeenCalled();
  });

  it('reads the digest before the recordings, so a delete between the two is withheld', async () => {
    const order: string[] = [];
    findOf.mockImplementation(async () => {
      order.push('digest');

      return buildMeetingDigestRecord();
    });
    execute.mockImplementation(async (query: unknown) => {
      if (query instanceof FindVisibleMeetingQuery) {
        return MEETING;
      }
      order.push('recordings');

      return transcribed;
    });

    await service.findOne(USER_ID, DIGEST_MEETING_ID);

    expect(order).toEqual(['digest', 'recordings']);
  });

  it('withholds content whose recording is no longer among the transcribed ones', async () => {
    transcribed = [];

    const digest = await service.findOne(USER_ID, DIGEST_MEETING_ID);

    expect(digest).toEqual({ meetingId: DIGEST_MEETING_ID, version: 3, status: 'ready' });
  });

  it('marks content out of date when a recording has been transcribed since', async () => {
    transcribed = [
      { id: FIRST_RECORDING_ID, uploaderId: USER_ID },
      { id: SECOND_RECORDING_ID, uploaderId: USER_ID },
    ];

    const digest = await service.findOne(USER_ID, DIGEST_MEETING_ID);

    expect(digest.content?.outOfDate).toBe(true);
  });

  it('answers version 0, without asking for recordings, for a meeting that never had a digest', async () => {
    findOf.mockResolvedValue(null);

    await expect(service.findOne(USER_ID, DIGEST_MEETING_ID)).resolves.toEqual({
      meetingId: DIGEST_MEETING_ID,
      version: 0,
    });
    expect(dispatched()).toEqual([new FindVisibleMeetingQuery(USER_ID, DIGEST_MEETING_ID)]);
  });

  it('does not ask for recordings while there is no content for them to decide about', async () => {
    findOf.mockResolvedValue(
      buildMeetingDigestRecord({
        status: DigestStatus.QUEUED,
        summary: null,
        generatedAt: null,
        actionItems: [],
        decisions: [],
        sources: [],
      }),
    );

    await expect(service.findOne(USER_ID, DIGEST_MEETING_ID)).resolves.toEqual({
      meetingId: DIGEST_MEETING_ID,
      version: 3,
      status: 'queued',
    });
    expect(dispatched()).toHaveLength(1);
  });

  it('answers the digest as it stands without asking who is looking, for a caller that has decided', async () => {
    const current = await service.currentOf(DIGEST_MEETING_ID);

    // The same answer the route gives, and no visibility query: an announcement has no user.
    expect(current).toEqual(await service.findOne(USER_ID, DIGEST_MEETING_ID));
    expect(dispatched()[0]).toEqual(new FindTranscribedRecordingsQuery(DIGEST_MEETING_ID));
  });
});
