import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { MeetingFileUploadHoldRepository } from '../../services/meeting-file-upload-hold.repository';
import { MeetingFileUploadRepository } from '../../services/meeting-file-upload.repository';
import type { MeetingFileUploadRecord } from '../../services/meeting-file-upload.mapper';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { StoreChunkCommand } from '../store-chunk.command';
import { StoreChunkHandler } from './store-chunk.handler';

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

/** 20 bytes in chunks of 8: two full chunks and a four-byte tail. */
const RECORD: MeetingFileUploadRecord = {
  id: UPLOAD_ID,
  meetingId: MEETING_ID,
  uploaderId: USER_ID,
  name: 'recording.mp4',
  size: 20,
  chunkSize: 8,
  chunkCount: 3,
  receivedChunks: [],
  attempts: 0,
  leasedUntil: null,
  createdAt: new Date('2026-09-19T10:00:00.000Z'),
  expiresAt: new Date('2026-09-20T10:00:00.000Z'),
  purgedAt: null,
};

describe('StoreChunkHandler', () => {
  const execute = jest.fn();
  const findOwned = jest.fn();
  const addReceivedChunk = jest.fn();
  const whileLive = jest.fn();
  let root: string;
  let storage: MeetingFileStorage;
  let handler: StoreChunkHandler;

  const command = (index: number, bytes: Buffer): StoreChunkCommand =>
    new StoreChunkCommand(USER_ID, MEETING_ID, UPLOAD_ID, index, bytes);

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);
    findOwned.mockReset().mockResolvedValue(RECORD);
    addReceivedChunk.mockReset().mockResolvedValue([0]);
    // A live session: the write runs, held.
    whileLive
      .mockReset()
      .mockImplementation(async (_uploadId: string, write: () => Promise<void>) => {
        await write();

        return true;
      });

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-chunk-'));
    storage = new MeetingFileStorage({ getOrThrow: () => root } as unknown as ConfigService);
    await storage.onModuleInit();

    const moduleRef = await Test.createTestingModule({
      providers: [
        StoreChunkHandler,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileUploadRepository, useValue: { findOwned, addReceivedChunk } },
        { provide: MeetingFileUploadHoldRepository, useValue: { whileLive } },
        { provide: MeetingFileStorage, useValue: storage },
      ],
    }).compile();

    handler = moduleRef.get(StoreChunkHandler);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const chunkPath = (index: number): string => path.join(root, 'uploads', UPLOAD_ID, String(index));

  it('writes the chunk under its key and only then records the index', async () => {
    const order: string[] = [];
    addReceivedChunk.mockImplementation(() => {
      order.push(fs.existsSync(chunkPath(0)) ? 'on disk' : 'missing');

      return Promise.resolve([0]);
    });

    await expect(handler.execute(command(0, Buffer.alloc(8, 0x01)))).resolves.toBeUndefined();

    expect(order).toEqual(['on disk']);
    expect(fs.readFileSync(chunkPath(0))).toEqual(Buffer.alloc(8, 0x01));
    expect(addReceivedChunk).toHaveBeenCalledWith(UPLOAD_ID, 0);
    // Nothing is left in the temp directory once the chunk is in place.
    expect(fs.readdirSync(storage.tempDir())).toEqual([]);
  });

  it('accepts the remainder as the last chunk', async () => {
    await expect(handler.execute(command(2, Buffer.alloc(4, 0x02)))).resolves.toBeUndefined();

    expect(fs.readFileSync(chunkPath(2))).toEqual(Buffer.alloc(4, 0x02));
  });

  it.each([
    ['one past the last index', 3],
    ['a negative index', -1],
    ['a fractional index', 1.5],
  ])('answers 400 Chunk index out of range for %s, writing nothing', async (_d, index) => {
    await expect(handler.execute(command(index, Buffer.alloc(8)))).rejects.toThrow(
      new BadRequestException('Chunk index out of range'),
    );

    expect(fs.existsSync(path.join(root, 'uploads'))).toBe(false);
    expect(addReceivedChunk).not.toHaveBeenCalled();
  });

  it.each([
    ['a short chunk', 0, 7],
    ['a long chunk', 0, 9],
    ['a full-length last chunk', 2, 8],
    ['an empty body', 0, 0],
  ])('answers 400 Chunk length does not match for %s', async (_d, index, length) => {
    await expect(handler.execute(command(index, Buffer.alloc(length)))).rejects.toThrow(
      new BadRequestException('Chunk length does not match'),
    );

    expect(fs.existsSync(path.join(root, 'uploads'))).toBe(false);
    expect(addReceivedChunk).not.toHaveBeenCalled();
    expect(fs.readdirSync(storage.tempDir())).toEqual([]);
  });

  it('answers 404 Meeting not found before the body is looked at', async () => {
    execute.mockResolvedValue(null);

    await expect(handler.execute(command(0, Buffer.alloc(0)))).rejects.toThrow(
      new NotFoundException('Meeting not found'),
    );

    expect(findOwned).not.toHaveBeenCalled();
  });

  it('answers 404 Upload not found for a session that is missing, expired, or another user’s', async () => {
    findOwned.mockResolvedValue(null);

    await expect(handler.execute(command(0, Buffer.alloc(8)))).rejects.toThrow(
      new NotFoundException('Upload not found'),
    );

    expect(fs.existsSync(path.join(root, 'uploads'))).toBe(false);
  });

  it('moves the chunk into place only while the session is held live', async () => {
    const seenDuringHold: boolean[] = [];
    whileLive.mockImplementation(async (_uploadId: string, write: () => Promise<void>) => {
      seenDuringHold.push(fs.existsSync(chunkPath(0)));
      await write();
      seenDuringHold.push(fs.existsSync(chunkPath(0)));

      return true;
    });

    await handler.execute(command(0, Buffer.alloc(8, 0x01)));

    expect(whileLive).toHaveBeenCalledWith(UPLOAD_ID, expect.any(Function));
    expect(seenDuringHold).toEqual([false, true]);
  });

  // The session ended between the lookup and the move: the purge may already have been, so a
  // chunk renamed into place now would be one nothing ever removes.
  it('answers 404 and stores nothing for a session that ended before the move', async () => {
    whileLive.mockResolvedValue(false);

    await expect(handler.execute(command(0, Buffer.alloc(8)))).rejects.toThrow(
      new NotFoundException('Upload not found'),
    );

    expect(fs.existsSync(path.join(root, 'uploads'))).toBe(false);
    expect(fs.readdirSync(storage.tempDir())).toEqual([]);
    expect(addReceivedChunk).not.toHaveBeenCalled();
  });

  it('answers 404 when the session ends between the move and the acknowledgement', async () => {
    addReceivedChunk.mockResolvedValue(null);

    await expect(handler.execute(command(0, Buffer.alloc(8)))).rejects.toThrow(
      new NotFoundException('Upload not found'),
    );

    // The bytes stay for the worker's removeTree: whatever ended the session waited for the
    // hold, so its purge comes after this chunk and takes it with the rest of the tree.
    expect(fs.existsSync(chunkPath(0))).toBe(true);
  });

  it('leaves no temp file behind when the move fails', async () => {
    jest.spyOn(storage, 'placeChunk').mockRejectedValue(new Error('disk full'));

    await expect(handler.execute(command(0, Buffer.alloc(8)))).rejects.toThrow('disk full');

    expect(fs.readdirSync(storage.tempDir())).toEqual([]);
    expect(addReceivedChunk).not.toHaveBeenCalled();
  });
});
