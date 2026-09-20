import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventBus, QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { MeetingFileChangedEvent } from '../../events/meeting-file-changed.event';
import { MeetingFileRepository } from '../../services/meeting-file.repository';
import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import { DeleteMeetingFileCommand } from '../delete-meeting-file.command';
import { DeleteMeetingFileHandler } from './delete-meeting-file.handler';

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
  status: 'uploaded',
  failureReason: null,
  attempts: 0,
  leasedUntil: null,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  processedAt: null,
  deletedAt: null,
  purgedAt: null,
};

describe('DeleteMeetingFileHandler', () => {
  const execute = jest.fn();
  const findOneOf = jest.fn();
  const transition = jest.fn();
  const publish = jest.fn();
  let handler: DeleteMeetingFileHandler;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);
    findOneOf.mockReset().mockResolvedValue(RECORD);
    transition.mockReset().mockResolvedValue(true);
    publish.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        DeleteMeetingFileHandler,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileRepository, useValue: { findOneOf, transition } },
        { provide: EventBus, useValue: { publish } },
      ],
    }).compile();

    handler = moduleRef.get(DeleteMeetingFileHandler);
  });

  it.each([
    ['the uploader', UPLOADER_ID],
    ['the host', HOST_ID],
  ])(
    'lets %s soft-delete: a conditional transition to deleted with the lease cleared',
    async (_who, userId) => {
      await expect(
        handler.execute(new DeleteMeetingFileCommand(userId, MEETING_ID, FILE_ID)),
      ).resolves.toBeUndefined();

      expect(transition).toHaveBeenCalledTimes(1);
      expect(transition).toHaveBeenCalledWith(FILE_ID, 'uploaded', 'deleted', {
        deletedAt: expect.any(Date),
        leasedUntil: null,
      });
    },
  );

  it('answers 404 File not found to another participant, writing nothing', async () => {
    await expect(
      handler.execute(new DeleteMeetingFileCommand(OTHER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(new NotFoundException('File not found'));

    expect(transition).not.toHaveBeenCalled();
  });

  it('answers 404 Meeting not found to a stranger before reading the file', async () => {
    execute.mockResolvedValue(null);

    await expect(
      handler.execute(new DeleteMeetingFileCommand(OTHER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(new NotFoundException('Meeting not found'));

    expect(findOneOf).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing or already deleted file', async () => {
    findOneOf.mockResolvedValue(null);

    await expect(
      handler.execute(new DeleteMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(new NotFoundException('File not found'));
  });

  it('re-reads once and retries from the new status when the worker moved the row meanwhile', async () => {
    transition.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    findOneOf
      .mockResolvedValueOnce(RECORD)
      .mockResolvedValueOnce({ ...RECORD, status: 'processing' });

    await expect(
      handler.execute(new DeleteMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID)),
    ).resolves.toBeUndefined();

    expect(transition).toHaveBeenNthCalledWith(
      1,
      FILE_ID,
      'uploaded',
      'deleted',
      expect.anything(),
    );
    expect(transition).toHaveBeenNthCalledWith(
      2,
      FILE_ID,
      'processing',
      'deleted',
      expect.anything(),
    );
  });

  it('answers 409 rather than looping when the second attempt also misses', async () => {
    transition.mockResolvedValue(false);

    await expect(
      handler.execute(new DeleteMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(
      new ConflictException('The file changed while it was being deleted; try again'),
    );

    expect(transition).toHaveBeenCalledTimes(2);
  });

  it('answers 404 when the re-read finds the row deleted by someone else', async () => {
    transition.mockResolvedValue(false);
    findOneOf.mockResolvedValueOnce(RECORD).mockResolvedValueOnce(null);

    await expect(
      handler.execute(new DeleteMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(new NotFoundException('File not found'));
  });

  it('announces the deleted file once the transition has resolved', async () => {
    const order: string[] = [];
    transition.mockImplementation(async () => {
      await Promise.resolve();
      order.push('transition');

      return true;
    });
    publish.mockImplementation(() => order.push('publish'));

    await handler.execute(new DeleteMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID));

    expect(order).toEqual(['transition', 'publish']);
    expect(publish).toHaveBeenCalledTimes(1);

    const [event] = publish.mock.calls[0] as [MeetingFileChangedEvent];
    expect(event).toBeInstanceOf(MeetingFileChangedEvent);
    expect(event.meetingId).toBe(MEETING_ID);
    // `deleted` is what tells a subscriber to take the row out of its list.
    expect(event.file).toMatchObject({ id: FILE_ID, status: 'deleted' });
  });

  it('announces once, not twice, when the first attempt lost its race', async () => {
    transition.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    findOneOf
      .mockResolvedValueOnce(RECORD)
      .mockResolvedValueOnce({ ...RECORD, status: 'processing' });

    await handler.execute(new DeleteMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID));

    // The attempt that changed nothing announced nothing; the one that won did.
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('announces nothing when neither attempt changes a row', async () => {
    transition.mockResolvedValue(false);

    await expect(
      handler.execute(new DeleteMeetingFileCommand(UPLOADER_ID, MEETING_ID, FILE_ID)),
    ).rejects.toThrow(ConflictException);

    expect(publish).not.toHaveBeenCalled();
  });
});
