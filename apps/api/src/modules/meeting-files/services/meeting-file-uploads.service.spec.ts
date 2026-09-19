import { NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { MeetingFileUploadRepository } from './meeting-file-upload.repository';
import type { MeetingFileUploadRecord } from './meeting-file-upload.mapper';
import { MeetingFileUploadsService } from './meeting-file-uploads.service';

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
  receivedChunks: [1, 0],
  attempts: 0,
  leasedUntil: null,
  createdAt: new Date('2026-09-19T10:00:00.000Z'),
  expiresAt: new Date('2026-09-20T10:00:00.000Z'),
  purgedAt: null,
};

describe('MeetingFileUploadsService', () => {
  const execute = jest.fn();
  const findOwned = jest.fn();
  let service: MeetingFileUploadsService;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);
    findOwned.mockReset().mockResolvedValue(RECORD);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFileUploadsService,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileUploadRepository, useValue: { findOwned } },
      ],
    }).compile();

    service = moduleRef.get(MeetingFileUploadsService);
  });

  it('answers with the session, chunks ascending', async () => {
    await expect(service.findOne(USER_ID, MEETING_ID, UPLOAD_ID)).resolves.toMatchObject({
      id: UPLOAD_ID,
      receivedChunks: [0, 1],
    });

    expect(findOwned).toHaveBeenCalledWith(MEETING_ID, UPLOAD_ID, USER_ID);
  });

  it('resolves the meeting before the session, so a stranger hears only about the meeting', async () => {
    execute.mockResolvedValue(null);

    await expect(service.findOne(USER_ID, MEETING_ID, UPLOAD_ID)).rejects.toThrow(
      new NotFoundException('Meeting not found'),
    );

    expect(findOwned).not.toHaveBeenCalled();
  });

  it('answers 404 Upload not found for a session that is missing, expired, or another user’s', async () => {
    findOwned.mockResolvedValue(null);

    await expect(service.findOne(USER_ID, MEETING_ID, UPLOAD_ID)).rejects.toThrow(
      new NotFoundException('Upload not found'),
    );
  });
});
