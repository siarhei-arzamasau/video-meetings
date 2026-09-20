import { ConflictException, NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { MeetingFileRepository } from '../../services/meeting-file.repository';
import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
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

const RECORD: MeetingFileRecord = {
  id: FILE_ID,
  meetingId: MEETING_ID,
  uploaderId: UPLOADER_ID,
  name: 'deck.pdf',
  contentType: 'application/pdf',
  size: 10,
  storageKey: `${MEETING_ID}/${FILE_ID}`,
  checksum: null,
  thumbnailKey: null,
  transcriptKey: null,
  status: 'failed',
  failureReason: 'The stored file is incomplete',
  attempts: 3,
  leasedUntil: null,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  processedAt: new Date('2026-09-01T10:00:01.000Z'),
  deletedAt: null,
  purgedAt: null,
};

describe('RetryMeetingFileHandler', () => {
  const execute = jest.fn();
  const findOneOf = jest.fn();
  const transition = jest.fn();
  let handler: RetryMeetingFileHandler;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);
    findOneOf.mockReset().mockResolvedValue(RECORD);
    transition.mockReset().mockResolvedValue(true);

    const moduleRef = await Test.createTestingModule({
      providers: [
        RetryMeetingFileHandler,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileRepository, useValue: { findOneOf, transition } },
      ],
    }).compile();

    handler = moduleRef.get(RetryMeetingFileHandler);
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
});
