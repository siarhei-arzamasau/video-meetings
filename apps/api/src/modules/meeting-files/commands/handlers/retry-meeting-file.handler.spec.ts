import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventBus, QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { MeetingFileChangedEvent } from '../../events/meeting-file-changed.event';
import { holdWrite, nextTurn } from '../../services/held-write.fixture';
import { MeetingFileHandOvers } from '../../services/meeting-file-hand-overs';
import { MeetingFileRepository } from '../../services/meeting-file.repository';
import { buildMeetingFileRecord } from '../../services/meeting-file-record.fixture';
import { RetryMeetingFileCommand } from '../retry-meeting-file.command';
import { NOT_FAILED_MESSAGE, RetryMeetingFileHandler } from './retry-meeting-file.handler';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const UPLOADER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';

const MEETING = {
  id: MEETING_ID,
  title: 'Engine review',
  status: 'scheduled',
  hostId: HOST_ID,
  scheduledAt: '2026-08-01T10:00:00.000Z',
  participantIds: [UPLOADER_ID, OTHER_ID],
};

const RECORD = buildMeetingFileRecord({
  id: FILE_ID,
  meetingId: MEETING_ID,
  uploaderId: UPLOADER_ID,
  status: 'failed',
  failureReason: 'The stored file is incomplete',
  attempts: 3,
  processedAt: new Date('2026-09-01T10:00:01.000Z'),
});

describe('RetryMeetingFileHandler', () => {
  const execute = jest.fn();
  const findOneOf = jest.fn();
  const transition = jest.fn();
  const publish = jest.fn();
  let handler: RetryMeetingFileHandler;
  let handOvers: MeetingFileHandOvers;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);
    findOneOf.mockReset().mockResolvedValue(RECORD);
    transition.mockReset().mockResolvedValue(true);
    publish.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        RetryMeetingFileHandler,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileRepository, useValue: { findOneOf, transition } },
        { provide: EventBus, useValue: { publish } },
        MeetingFileHandOvers,
      ],
    }).compile();

    handler = moduleRef.get(RetryMeetingFileHandler);
    handOvers = moduleRef.get(MeetingFileHandOvers);
  });

  it.each([
    ['the uploader', UPLOADER_ID],
    ['the host', HOST_ID],
  ])('lets %s send a failed file back through the pipeline', async (_who, userId) => {
    const file = await handler.execute(new RetryMeetingFileCommand(userId, MEETING_ID, FILE_ID));

    expect(transition).toHaveBeenCalledTimes(1);
    // A retry is a fresh chance, not a fourth attempt against the worker's cap of three.
    expect(transition).toHaveBeenCalledWith(FILE_ID, 'failed', 'uploaded', {
      attempts: 0,
      failureReason: null,
      processedAt: null,
      leasedUntil: null,
    });
    expect(file).toMatchObject({ id: FILE_ID, status: 'uploaded' });
    expect(file.failureReason).toBeUndefined();
    expect(file.processedAt).toBeUndefined();
  });

  it('answers 404 File not found to another participant, writing nothing', async () => {
    await expect(
      handler.execute(new RetryMeetingFileCommand(OTHER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(new NotFoundException('File not found'));

    expect(transition).not.toHaveBeenCalled();
  });

  it('answers 404 Meeting not found to a stranger before reading the file', async () => {
    execute.mockResolvedValue(null);

    await expect(
      handler.execute(new RetryMeetingFileCommand(OTHER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(new NotFoundException('Meeting not found'));

    expect(findOneOf).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing or already deleted file', async () => {
    findOneOf.mockResolvedValue(null);

    await expect(
      handler.execute(new RetryMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(new NotFoundException('File not found'));

    expect(transition).not.toHaveBeenCalled();
  });

  it('answers 409 when the row is no longer failed', async () => {
    transition.mockResolvedValue(false);

    await expect(
      handler.execute(new RetryMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(new ConflictException(NOT_FAILED_MESSAGE));
  });

  it('announces the retried file once the transition has resolved', async () => {
    const order: string[] = [];
    transition.mockImplementation(async () => {
      await Promise.resolve();
      order.push('transition');

      return true;
    });
    publish.mockImplementation(() => order.push('publish'));

    const file = await handler.execute(
      new RetryMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID),
    );

    expect(order).toEqual(['transition', 'publish']);
    expect(publish).toHaveBeenCalledTimes(1);

    const [event] = publish.mock.calls[0] as [MeetingFileChangedEvent];
    expect(event).toBeInstanceOf(MeetingFileChangedEvent);
    expect(event.meetingId).toBe(MEETING_ID);
    // The same row the caller is answered with: one retry, one truth.
    expect(event.file).toEqual(file);
  });

  it('announces nothing when the row is no longer failed', async () => {
    transition.mockResolvedValue(false);

    await expect(
      handler.execute(new RetryMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(ConflictException);

    expect(publish).not.toHaveBeenCalled();
  });

  it('is a hand-over: a claim that comes back mid-retry is announced after it, not before', async () => {
    const write = holdWrite<boolean>();
    const order: string[] = [];
    transition.mockReturnValue(write.answered);
    publish.mockImplementation(() => order.push('uploaded'));

    const retried = handler.execute(new RetryMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID));
    await nextTurn();
    // The worker's side: its claim of this file came back while the write was still out.
    const claimed = handOvers.announced(FILE_ID).then(() => order.push('processing'));
    await nextTurn();
    expect(order).toEqual([]);

    write.answer(true);
    await Promise.all([retried, claimed]);

    expect(order).toEqual(['uploaded', 'processing']);
  });
});
