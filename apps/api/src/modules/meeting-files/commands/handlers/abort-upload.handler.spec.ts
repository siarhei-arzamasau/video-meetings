import { NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { MeetingFileUploadRepository } from '../../services/meeting-file-upload.repository';
import type { MeetingFileUploadRecord } from '../../services/meeting-file-upload.mapper';
import { AbortUploadCommand } from '../abort-upload.command';
import { AbortUploadHandler } from './abort-upload.handler';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const UPLOAD_ID = '66666666-6666-4666-8666-666666666666';

const MEETING = {
  id: MEETING_ID,
  title: 'Engine review',
  status: 'scheduled',
  hostId: USER_ID,
  scheduledAt: '2026-08-01T10:00:00.000Z',
  participantIds: [],
};

const RECORD: MeetingFileUploadRecord = {
  id: UPLOAD_ID,
  meetingId: MEETING_ID,
  uploaderId: USER_ID,
  name: 'recording.mp4',
  size: 20,
  chunkSize: 8,
  chunkCount: 3,
  receivedChunks: [0],
  attempts: 0,
  leasedUntil: null,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  purgedAt: null,
};

describe('AbortUploadHandler', () => {
  const execute = jest.fn();
  const findOwned = jest.fn();
  const expire = jest.fn();
  let handler: AbortUploadHandler;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);
    findOwned.mockReset().mockResolvedValue(RECORD);
    expire.mockReset().mockResolvedValue(true);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AbortUploadHandler,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileUploadRepository, useValue: { findOwned, expire } },
      ],
    }).compile();

    handler = moduleRef.get(AbortUploadHandler);
  });

  it('expires the session and leaves the chunks to the worker', async () => {
    await expect(
      handler.execute(new AbortUploadCommand(USER_ID, MEETING_ID, UPLOAD_ID)),
    ).resolves.toBeUndefined();

    expect(expire).toHaveBeenCalledWith(UPLOAD_ID);
  });

  it('answers 404 for a session that is missing, expired, or another user’s', async () => {
    findOwned.mockResolvedValue(null);

    await expect(
      handler.execute(new AbortUploadCommand(USER_ID, MEETING_ID, UPLOAD_ID)),
    ).rejects.toThrow(new NotFoundException('Upload not found'));

    expect(expire).not.toHaveBeenCalled();
  });

  it('answers 404 when another abort got there first', async () => {
    expire.mockResolvedValue(false);

    await expect(
      handler.execute(new AbortUploadCommand(USER_ID, MEETING_ID, UPLOAD_ID)),
    ).rejects.toThrow(new NotFoundException('Upload not found'));
  });

  it('answers 404 Meeting not found to a stranger, before the session is read', async () => {
    execute.mockResolvedValue(null);

    await expect(
      handler.execute(new AbortUploadCommand(USER_ID, MEETING_ID, UPLOAD_ID)),
    ).rejects.toThrow(new NotFoundException('Meeting not found'));

    expect(findOwned).not.toHaveBeenCalled();
  });
});
