import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { MeetingDigestAnnouncer } from '../../services/meeting-digest-announcer';
import {
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
  buildMeetingDigestRecord,
} from '../../services/meeting-digest-record.fixture';
import { DigestStatus } from '../../services/meeting-digest-status';
import { MeetingDigestRepository } from '../../services/meeting-digest.repository';
import { MeetingDigestsService } from '../../services/meeting-digests.service';
import { RequestMeetingDigestCommand } from '../request-meeting-digest.command';
import {
  DIGEST_REFUSAL_MESSAGES,
  DIGEST_SWITCHED_OFF_MESSAGE,
  RequestMeetingDigestHandler,
} from './request-meeting-digest.handler';

const HOST_ID = '22222222-2222-4222-8222-222222222222';
const UPLOADER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '77777777-7777-4777-8777-777777777777';
const MEETING = { id: DIGEST_MEETING_ID, hostId: HOST_ID };
const NOT_FOUND = new NotFoundException('Meeting not found');

/** The row as the request left it, and the digest it is answered as. */
const QUEUED_RECORD = buildMeetingDigestRecord({ status: DigestStatus.QUEUED, version: 4 });
const QUEUED_DIGEST = { meetingId: DIGEST_MEETING_ID, version: 4, status: 'queued' };

describe('RequestMeetingDigestHandler', () => {
  const requireVisibleMeeting = jest.fn();
  const transcribedRecordingsOf = jest.fn();
  const describeRecord = jest.fn();
  const requestByHand = jest.fn();
  const announce = jest.fn();
  let enabled: boolean;
  let handler: RequestMeetingDigestHandler;

  const requestAs = (userId: string): Promise<unknown> =>
    handler.execute(new RequestMeetingDigestCommand(userId, DIGEST_MEETING_ID));

  beforeEach(async () => {
    enabled = true;
    requireVisibleMeeting.mockReset().mockResolvedValue(MEETING);
    transcribedRecordingsOf.mockReset().mockResolvedValue([
      { id: FIRST_RECORDING_ID, uploaderId: UPLOADER_ID },
      { id: SECOND_RECORDING_ID, uploaderId: HOST_ID },
    ]);
    describeRecord.mockReset().mockResolvedValue(QUEUED_DIGEST);
    requestByHand
      .mockReset()
      .mockResolvedValue({ allowed: true, action: 'generate', record: QUEUED_RECORD });
    announce.mockReset().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        RequestMeetingDigestHandler,
        { provide: ConfigService, useValue: { get: jest.fn(() => enabled) } },
        {
          provide: MeetingDigestsService,
          useValue: { requireVisibleMeeting, transcribedRecordingsOf, describe: describeRecord },
        },
        { provide: MeetingDigestRepository, useValue: { requestByHand } },
        { provide: MeetingDigestAnnouncer, useValue: { announce } },
      ],
    }).compile();

    handler = moduleRef.get(RequestMeetingDigestHandler);
  });

  it.each([
    ['the host', HOST_ID],
    ['the uploader of a transcribed recording', UPLOADER_ID],
  ])('lets %s ask, and answers the digest as the request left it', async (_who, userId) => {
    await expect(requestAs(userId)).resolves.toBe(QUEUED_DIGEST);

    expect(requireVisibleMeeting).toHaveBeenCalledWith(userId, DIGEST_MEETING_ID);
    // The recordings the gate read are the ones the request is decided against.
    expect(requestByHand).toHaveBeenCalledTimes(1);
    expect(requestByHand).toHaveBeenCalledWith(DIGEST_MEETING_ID, [
      FIRST_RECORDING_ID,
      SECOND_RECORDING_ID,
    ]);
    // Described from the row the write returned, not from a second read of the table.
    expect(describeRecord).toHaveBeenCalledWith(DIGEST_MEETING_ID, QUEUED_RECORD);
  });

  it('announces the request once it is written, and not before', async () => {
    const order: string[] = [];
    requestByHand.mockImplementation(async () => {
      order.push('written');

      return { allowed: true, action: 'retry', record: QUEUED_RECORD };
    });
    announce.mockImplementation(async () => {
      order.push('announced');
    });

    await requestAs(HOST_ID);

    expect(order).toEqual(['written', 'announced']);
    expect(announce).toHaveBeenCalledWith(DIGEST_MEETING_ID);
  });

  it('lets the host ask for a meeting whose recordings are all somebody else’s', async () => {
    transcribedRecordingsOf.mockResolvedValue([
      { id: FIRST_RECORDING_ID, uploaderId: UPLOADER_ID },
    ]);

    await expect(requestAs(HOST_ID)).resolves.toBe(QUEUED_DIGEST);
  });

  it('answers 404 to someone who cannot see the meeting, before anything of it is read', async () => {
    requireVisibleMeeting.mockRejectedValue(NOT_FOUND);

    await expect(requestAs(OTHER_ID)).rejects.toThrow(NOT_FOUND);

    expect(transcribedRecordingsOf).not.toHaveBeenCalled();
    expect(requestByHand).not.toHaveBeenCalled();
  });

  it('answers the same 404 to a participant who uploaded no transcribed recording', async () => {
    await expect(requestAs(OTHER_ID)).rejects.toThrow(NOT_FOUND);

    expect(requestByHand).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  describe('with the digest switched off', () => {
    beforeEach(() => {
      enabled = false;
    });

    it('answers 409 to someone who could have asked, writing nothing', async () => {
      await expect(requestAs(HOST_ID)).rejects.toThrow(
        new ConflictException(DIGEST_SWITCHED_OFF_MESSAGE),
      );

      expect(requestByHand).not.toHaveBeenCalled();
      expect(announce).not.toHaveBeenCalled();
    });

    it('still answers 404 to everyone else: the setting is not theirs to learn', async () => {
      await expect(requestAs(OTHER_ID)).rejects.toThrow(NOT_FOUND);

      requireVisibleMeeting.mockRejectedValue(NOT_FOUND);
      await expect(requestAs(HOST_ID)).rejects.toThrow(NOT_FOUND);
    });
  });

  it.each([
    ['is queued or generating', 'UNDER_WAY', 'A digest is already queued or being generated'],
    ['is current', 'CURRENT', 'The digest already covers every transcribed recording'],
    [
      'has no recording to be built from',
      'NO_RECORDING',
      'The meeting has no transcribed recording to generate a digest from',
    ],
  ] as const)(
    'answers 409 for a digest that %s, announcing nothing',
    async (_what, refusal, message) => {
      requestByHand.mockResolvedValue({ allowed: false, refusal });

      await expect(requestAs(HOST_ID)).rejects.toThrow(new ConflictException(message));

      expect(DIGEST_REFUSAL_MESSAGES[refusal]).toBe(message);
      // A refusal changed nothing, so there is nothing to tell an open page.
      expect(announce).not.toHaveBeenCalled();
      expect(describeRecord).not.toHaveBeenCalled();
    },
  );

  it('lets a failure of the write through, announcing nothing', async () => {
    requestByHand.mockRejectedValue(new Error('connection lost'));

    await expect(requestAs(HOST_ID)).rejects.toThrow('connection lost');

    expect(announce).not.toHaveBeenCalled();
  });
});
