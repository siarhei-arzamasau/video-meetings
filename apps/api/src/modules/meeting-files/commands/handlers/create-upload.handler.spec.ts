import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { MAX_CHUNKED_MEETING_FILE_SIZE_BYTES, MEETING_FILE_CHUNK_SIZE_BYTES } from '@repo/shared';

import { UploadCapReached } from '../../services/meeting-file-upload-caps';
import { MeetingFileUploadRepository } from '../../services/meeting-file-upload.repository';
import type { MeetingFileUploadRecord } from '../../services/meeting-file-upload.mapper';
import { CreateUploadCommand } from '../create-upload.command';
import { CreateUploadHandler } from './create-upload.handler';

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
  size: 3 * MEETING_FILE_CHUNK_SIZE_BYTES,
  chunkSize: MEETING_FILE_CHUNK_SIZE_BYTES,
  chunkCount: 3,
  receivedChunks: [],
  attempts: 0,
  leasedUntil: null,
  createdAt: new Date('2026-09-19T10:00:00.000Z'),
  expiresAt: new Date('2026-09-20T10:00:00.000Z'),
  purgedAt: null,
};

describe('CreateUploadHandler', () => {
  const execute = jest.fn();
  const createWithinCap = jest.fn();
  const get = jest.fn();
  let handler: CreateUploadHandler;

  const build = async (): Promise<CreateUploadHandler> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CreateUploadHandler,
        { provide: ConfigService, useValue: { get } },
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileUploadRepository, useValue: { createWithinCap } },
      ],
    }).compile();

    return moduleRef.get(CreateUploadHandler);
  };

  const command = (name: string, size: number): CreateUploadCommand =>
    new CreateUploadCommand(USER_ID, MEETING_ID, name, size);

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);
    createWithinCap.mockReset().mockResolvedValue(RECORD);
    get.mockReset().mockImplementation((_key: string, fallback: number) => fallback);

    handler = await build();
  });

  it('writes the session with the server chunk plan and the TTL', async () => {
    const before = Date.now();

    await expect(handler.execute(command('  recording.mp4  ', 20))).resolves.toMatchObject({
      id: UPLOAD_ID,
      receivedChunks: [],
    });

    expect(createWithinCap).toHaveBeenCalledTimes(1);
    const [data, caps] = createWithinCap.mock.calls[0] as [Record<string, unknown>, object];
    expect(data).toMatchObject({
      meetingId: MEETING_ID,
      uploaderId: USER_ID,
      // Trimmed by the same rule the single-request path uses.
      name: 'recording.mp4',
      size: 20,
      chunkSize: MEETING_FILE_CHUNK_SIZE_BYTES,
      chunkCount: 1,
    });
    expect(caps).toEqual({ meetingFiles: 50, openUploadsPerUploader: 5 });
    expect((data['expiresAt'] as Date).getTime()).toBeGreaterThanOrEqual(
      before + 24 * 60 * 60 * 1_000,
    );
  });

  it('plans one chunk per chunk size, rounding up', async () => {
    await handler.execute(command('recording.mp4', 2 * MEETING_FILE_CHUNK_SIZE_BYTES + 1));

    expect(createWithinCap).toHaveBeenCalledWith(
      expect.objectContaining({ chunkCount: 3 }),
      expect.any(Object),
    );
  });

  it('honours a configured TTL', async () => {
    get.mockReturnValue(1);
    handler = await build();
    const before = Date.now();

    await handler.execute(command('recording.mp4', 20));

    const [data] = createWithinCap.mock.calls[0] as [Record<string, unknown>];
    expect((data['expiresAt'] as Date).getTime()).toBeLessThanOrEqual(
      before + 60 * 60 * 1_000 + 1_000,
    );
  });

  it('answers 404 Meeting not found before anything is validated', async () => {
    execute.mockResolvedValue(null);

    await expect(handler.execute(command('a/b.mp4', 0))).rejects.toThrow(
      new NotFoundException('Meeting not found'),
    );

    expect(createWithinCap).not.toHaveBeenCalled();
  });

  it.each([
    ['a path separator', 'a/b.mp4'],
    ['a blank name', '   '],
  ])('answers 400 with the single-request path’s name message for %s', async (_d, name) => {
    await expect(handler.execute(command(name, 20))).rejects.toThrow(
      new BadRequestException(
        'The file name must be 1–255 characters and contain no path separators',
      ),
    );

    expect(createWithinCap).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['a negative size', -1],
    ['a fractional size', 1.5],
  ])('answers 400 for %s', async (_description, size) => {
    await expect(handler.execute(command('recording.mp4', size))).rejects.toThrow(
      new BadRequestException('The file size must be a positive number of bytes'),
    );

    expect(createWithinCap).not.toHaveBeenCalled();
  });

  it('answers 413 one byte over the chunked cap, and 201 at it', async () => {
    await expect(
      handler.execute(command('recording.mp4', MAX_CHUNKED_MEETING_FILE_SIZE_BYTES + 1)),
    ).rejects.toThrow(new PayloadTooLargeException('Files must be 1 GB or smaller.'));
    expect(createWithinCap).not.toHaveBeenCalled();

    await expect(
      handler.execute(command('recording.mp4', MAX_CHUNKED_MEETING_FILE_SIZE_BYTES)),
    ).resolves.toBeDefined();
  });

  it('answers 409 with the file-count message when the meeting cap is already reached', async () => {
    createWithinCap.mockResolvedValue(UploadCapReached.MEETING_FILES);

    await expect(handler.execute(command('recording.mp4', 20))).rejects.toThrow(
      new ConflictException('This meeting already has 50 files.'),
    );
  });

  it('answers 409 with the unfinished-uploads message when the uploader cap is reached', async () => {
    createWithinCap.mockResolvedValue(UploadCapReached.OPEN_UPLOADS);

    await expect(handler.execute(command('recording.mp4', 20))).rejects.toThrow(
      new ConflictException(
        'You already have 5 unfinished uploads. Finish or cancel one, or try again once they expire.',
      ),
    );
  });
});
