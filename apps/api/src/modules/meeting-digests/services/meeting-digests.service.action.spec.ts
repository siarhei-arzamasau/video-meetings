import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
const WITHOUT_CONTENT = { summary: null, generatedAt: null, actionItems: [], sources: [] };

/** `availableAction`, and what reading it costs: the part of the read the setting decides. */
describe('MeetingDigestsService, with the digest switched on or off', () => {
  const findOf = jest.fn();
  const execute = jest.fn();
  let enabled: boolean;
  let visibleMeeting: typeof MEETING | null;
  let transcribedFileIds: string[];
  let service: MeetingDigestsService;

  const dispatched = (): unknown[] => execute.mock.calls.map(([query]: [unknown]) => query);

  beforeEach(async () => {
    enabled = true;
    visibleMeeting = MEETING;
    transcribedFileIds = [FIRST_RECORDING_ID];
    execute.mockReset().mockImplementation(async (query: unknown) => {
      if (query instanceof FindVisibleMeetingQuery) {
        return visibleMeeting;
      }
      if (query instanceof FindTranscribedRecordingsQuery) {
        return transcribedFileIds.map((id) => ({ id, uploaderId: USER_ID }));
      }

      throw new Error('An unexpected query was dispatched');
    });
    findOf.mockReset().mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingDigestsService,
        // Asked on every read rather than once: the suite, like a spec, may flip it.
        { provide: ConfigService, useValue: { get: jest.fn(() => enabled) } },
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingDigestRepository, useValue: { findOf } },
      ],
    }).compile();

    service = moduleRef.get(MeetingDigestsService);
  });

  it('offers nothing for a meeting that never had a digest, and reads no recordings for it', async () => {
    await expect(service.currentOf(DIGEST_MEETING_ID)).resolves.toEqual({
      meetingId: DIGEST_MEETING_ID,
      version: 0,
    });
    // Nothing here is decided by the recordings: a digest that is owed is the catch-up's.
    expect(dispatched()).toEqual([]);
  });

  it('offers Retry for a failed digest, and nothing for one whose meeting has no recording left', async () => {
    findOf.mockResolvedValue(
      buildMeetingDigestRecord({ status: DigestStatus.FAILED, ...WITHOUT_CONTENT }),
    );
    await expect(service.currentOf(DIGEST_MEETING_ID)).resolves.toMatchObject({
      status: 'failed',
      availableAction: 'retry',
    });
    // The one read the setting costs, and only a failed digest: whether a recording is left.
    expect(dispatched()).toEqual([new FindTranscribedRecordingsQuery(DIGEST_MEETING_ID)]);

    transcribedFileIds = [];
    await expect(service.currentOf(DIGEST_MEETING_ID)).resolves.not.toHaveProperty(
      'availableAction',
    );
  });

  it('offers nothing for a digest that is out of date, which stays readable and marked', async () => {
    findOf.mockResolvedValue(buildMeetingDigestRecord());
    transcribedFileIds = [FIRST_RECORDING_ID, SECOND_RECORDING_ID];

    const digest = await service.currentOf(DIGEST_MEETING_ID);

    expect(digest).toMatchObject({ status: 'ready', content: { outOfDate: true } });
    expect(digest).not.toHaveProperty('availableAction');
  });

  it('offers nothing for a digest that covers every transcribed recording', async () => {
    findOf.mockResolvedValue(buildMeetingDigestRecord());

    const digest = await service.currentOf(DIGEST_MEETING_ID);

    expect(digest).toMatchObject({ status: 'ready', content: { outOfDate: false } });
    expect(digest).not.toHaveProperty('availableAction');
  });

  it.each([[DigestStatus.QUEUED], [DigestStatus.GENERATING]] as const)(
    'offers nothing for a %s digest, and reads no recordings to find that out',
    async (status) => {
      findOf.mockResolvedValue(buildMeetingDigestRecord({ status, ...WITHOUT_CONTENT }));

      const digest = await service.currentOf(DIGEST_MEETING_ID);

      expect(digest).not.toHaveProperty('availableAction');
      expect(dispatched()).toEqual([]);
    },
  );

  it('offers nothing while the setting is off, and reads no recordings for a meeting with no digest', async () => {
    enabled = false;

    await expect(service.currentOf(DIGEST_MEETING_ID)).resolves.toEqual({
      meetingId: DIGEST_MEETING_ID,
      version: 0,
    });
    expect(dispatched()).toEqual([]);

    findOf.mockResolvedValue(buildMeetingDigestRecord({ status: DigestStatus.FAILED }));
    await expect(service.currentOf(DIGEST_MEETING_ID)).resolves.not.toHaveProperty(
      'availableAction',
    );
  });

  describe('describe', () => {
    it('answers a row its caller has already read, without reading it again', async () => {
      const queued = buildMeetingDigestRecord({ status: DigestStatus.QUEUED, version: 8 });
      // What the table holds by now — a worker claimed it — is not what is answered.
      findOf.mockResolvedValue(buildMeetingDigestRecord({ status: DigestStatus.GENERATING }));

      const digest = await service.describe(DIGEST_MEETING_ID, queued);

      expect(digest).toMatchObject({ status: 'queued', version: 8, content: { outOfDate: false } });
      expect(findOf).not.toHaveBeenCalled();
    });

    it('is the second half of the read: the same answer for the same row', async () => {
      const record = buildMeetingDigestRecord({ status: DigestStatus.FAILED });
      findOf.mockResolvedValue(record);

      expect(await service.describe(DIGEST_MEETING_ID, record)).toEqual(
        await service.currentOf(DIGEST_MEETING_ID),
      );
    });
  });

  describe('requireVisibleMeeting', () => {
    it('answers the meeting for someone who can see it', async () => {
      await expect(service.requireVisibleMeeting(USER_ID, DIGEST_MEETING_ID)).resolves.toBe(
        MEETING,
      );
    });

    it('answers the one 404 for someone who cannot', async () => {
      visibleMeeting = null;

      await expect(service.requireVisibleMeeting(USER_ID, DIGEST_MEETING_ID)).rejects.toThrow(
        new NotFoundException('Meeting not found'),
      );
    });
  });
});
