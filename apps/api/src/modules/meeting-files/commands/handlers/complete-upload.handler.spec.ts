import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ConflictException,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { MeetingFileUploadRepository } from '../../services/meeting-file-upload.repository';
import { chunkKeyOf } from '../../services/meeting-file-upload.mapper';
import type { MeetingFileUploadRecord } from '../../services/meeting-file-upload.mapper';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { CompleteUploadCommand } from '../complete-upload.command';
import { UploadMeetingFileCommand } from '../upload-meeting-file.command';
import { CompleteUploadHandler } from './complete-upload.handler';

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

/** 20 bytes in chunks of 8, all three received. */
const RECORD: MeetingFileUploadRecord = {
  id: UPLOAD_ID,
  meetingId: MEETING_ID,
  uploaderId: USER_ID,
  name: 'recording.mp4',
  size: 20,
  chunkSize: 8,
  chunkCount: 3,
  receivedChunks: [0, 1, 2],
  attempts: 0,
  leasedUntil: null,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  purgedAt: null,
};

const FILE = { id: '77777777-7777-4777-8777-777777777777', status: 'uploaded' };

describe('CompleteUploadHandler', () => {
  const query = jest.fn();
  const command = jest.fn();
  const findOwned = jest.fn();
  const markPurged = jest.fn();
  let root: string;
  let storage: MeetingFileStorage;
  let handler: CompleteUploadHandler;

  /** Writes the session's chunks to disk: 8 bytes of 0x00, 8 of 0x01, 4 of 0x02. */
  const writeChunks = (lengths = [8, 8, 4]): Promise<void> =>
    lengths.reduce(async (previous, length, index) => {
      await previous;
      const source = path.join(storage.tempDir(), `source-${String(index)}`);
      fs.writeFileSync(source, Buffer.alloc(length, index));
      await storage.putChunk(chunkKeyOf(UPLOAD_ID, index), source);
    }, Promise.resolve());

  beforeEach(async () => {
    query.mockReset().mockResolvedValue(MEETING);
    command.mockReset().mockResolvedValue(FILE);
    findOwned.mockReset().mockResolvedValue(RECORD);
    markPurged.mockReset().mockResolvedValue(true);

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-upload-'));
    storage = new MeetingFileStorage({ getOrThrow: () => root } as unknown as ConfigService);
    await storage.onModuleInit();

    const moduleRef = await Test.createTestingModule({
      providers: [
        CompleteUploadHandler,
        { provide: QueryBus, useValue: { execute: query } },
        { provide: CommandBus, useValue: { execute: command } },
        { provide: MeetingFileUploadRepository, useValue: { findOwned, markPurged } },
        { provide: MeetingFileStorage, useValue: storage },
      ],
    }).compile();

    handler = moduleRef.get(CompleteUploadHandler);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const complete = (): Promise<unknown> =>
    handler.execute(new CompleteUploadCommand(USER_ID, MEETING_ID, UPLOAD_ID));

  it('assembles the chunks in index order and hands the path to the upload command', async () => {
    await writeChunks();
    let assembledBytes: Buffer | undefined;
    command.mockImplementation((dispatched: UploadMeetingFileCommand) => {
      assembledBytes = fs.readFileSync(dispatched.tempPath);

      return Promise.resolve(FILE);
    });

    await expect(complete()).resolves.toBe(FILE);

    expect(command).toHaveBeenCalledTimes(1);
    const dispatched = command.mock.calls[0]?.[0] as UploadMeetingFileCommand;
    expect(dispatched).toBeInstanceOf(UploadMeetingFileCommand);
    expect(dispatched).toMatchObject({
      userId: USER_ID,
      meetingId: MEETING_ID,
      originalName: 'recording.mp4',
      size: 20,
      // `<root>/tmp/<uploadId>`: the same filesystem as the destination, so the rename the
      // upload handler does is atomic.
      tempPath: path.join(storage.tempDir(), UPLOAD_ID),
    });
    expect(assembledBytes).toEqual(
      Buffer.concat([Buffer.alloc(8, 0), Buffer.alloc(8, 1), Buffer.alloc(4, 2)]),
    );
  });

  it('removes the chunk tree and only then marks the session purged', async () => {
    await writeChunks();
    const order: string[] = [];
    markPurged.mockImplementation(() => {
      order.push(fs.existsSync(path.join(root, 'uploads', UPLOAD_ID)) ? 'chunks' : 'no chunks');

      return Promise.resolve(true);
    });

    await complete();

    expect(order).toEqual(['no chunks']);
  });

  it('answers 409 when a chunk is missing, dispatching nothing', async () => {
    findOwned.mockResolvedValue({ ...RECORD, receivedChunks: [0, 2] });

    await expect(complete()).rejects.toThrow(new ConflictException('The upload is incomplete'));

    expect(command).not.toHaveBeenCalled();
    expect(markPurged).not.toHaveBeenCalled();
  });

  it('answers 409 when the assembled bytes do not add up to the declared size', async () => {
    // Every chunk present, but the last one short of what it was acknowledged as.
    await writeChunks([8, 8, 2]);

    await expect(complete()).rejects.toThrow(new ConflictException('The upload is incomplete'));

    expect(command).not.toHaveBeenCalled();
    // The temp file is not left behind for a completion that failed.
    expect(fs.readdirSync(storage.tempDir())).toEqual([]);
  });

  it('leaves the session and its chunks intact when the upload is rejected', async () => {
    await writeChunks();
    command.mockRejectedValue(
      new UnsupportedMediaTypeException('That file type is not supported.'),
    );

    await expect(complete()).rejects.toThrow(UnsupportedMediaTypeException);

    expect(fs.readdirSync(path.join(root, 'uploads', UPLOAD_ID)).toSorted()).toEqual([
      '0',
      '1',
      '2',
    ]);
    expect(markPurged).not.toHaveBeenCalled();
  });

  it('answers 404 for a session that is missing, expired, or another user’s', async () => {
    findOwned.mockResolvedValue(null);

    await expect(complete()).rejects.toThrow(new NotFoundException('Upload not found'));

    expect(command).not.toHaveBeenCalled();
  });

  it('answers 404 Meeting not found to a stranger, before the session is read', async () => {
    query.mockResolvedValue(null);

    await expect(complete()).rejects.toThrow(new NotFoundException('Meeting not found'));

    expect(findOwned).not.toHaveBeenCalled();
  });
});
