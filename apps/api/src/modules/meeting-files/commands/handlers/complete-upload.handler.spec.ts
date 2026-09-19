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
import { COMPLETION_LEASE_SECONDS, CompleteUploadHandler } from './complete-upload.handler';

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

/** The row as `claimForCompletion` hands it back: the same session, now under a lease. */
const LEASED_UNTIL = new Date(Date.now() + COMPLETION_LEASE_SECONDS * 1_000);
const CLAIMED: MeetingFileUploadRecord = { ...RECORD, leasedUntil: LEASED_UNTIL };

const FILE = { id: '77777777-7777-4777-8777-777777777777', status: 'uploaded' };

describe('CompleteUploadHandler', () => {
  const query = jest.fn();
  const command = jest.fn();
  const findOwned = jest.fn();
  const claimForCompletion = jest.fn();
  const releaseLease = jest.fn();
  const expire = jest.fn();
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
    claimForCompletion.mockReset().mockResolvedValue(CLAIMED);
    releaseLease.mockReset().mockResolvedValue(undefined);
    expire.mockReset().mockResolvedValue(true);
    markPurged.mockReset().mockResolvedValue(true);

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-upload-'));
    storage = new MeetingFileStorage({ getOrThrow: () => root } as unknown as ConfigService);
    await storage.onModuleInit();

    const moduleRef = await Test.createTestingModule({
      providers: [
        CompleteUploadHandler,
        { provide: QueryBus, useValue: { execute: query } },
        { provide: CommandBus, useValue: { execute: command } },
        {
          provide: MeetingFileUploadRepository,
          useValue: { findOwned, claimForCompletion, releaseLease, expire, markPurged },
        },
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

  const dispatchedCommand = (call = 0): UploadMeetingFileCommand =>
    command.mock.calls[call]?.[0] as UploadMeetingFileCommand;

  it('assembles the chunks in index order and hands the path to the upload command', async () => {
    await writeChunks();
    let assembledBytes: Buffer | undefined;
    command.mockImplementation((dispatched: UploadMeetingFileCommand) => {
      assembledBytes = fs.readFileSync(dispatched.tempPath);

      return Promise.resolve(FILE);
    });

    await expect(complete()).resolves.toBe(FILE);

    expect(command).toHaveBeenCalledTimes(1);
    const dispatched = dispatchedCommand();
    expect(dispatched).toBeInstanceOf(UploadMeetingFileCommand);
    expect(dispatched).toMatchObject({
      userId: USER_ID,
      meetingId: MEETING_ID,
      originalName: 'recording.mp4',
      size: 20,
    });
    // Under `<root>/tmp`: the same filesystem as the destination, so the rename the upload
    // handler does is atomic.
    expect(path.dirname(dispatched.tempPath)).toBe(storage.tempDir());
    expect(assembledBytes).toEqual(
      Buffer.concat([Buffer.alloc(8, 0), Buffer.alloc(8, 1), Buffer.alloc(4, 2)]),
    );
  });

  it('assembles into a temp file of its own, never one named after the session', async () => {
    // Two completions of one session — a retry racing the call it is retrying — must not
    // write into, or remove, one another's file.
    await writeChunks();
    await complete();
    await writeChunks();
    await complete();

    const [first, second] = [dispatchedCommand(0).tempPath, dispatchedCommand(1).tempPath];
    expect(path.basename(first)).not.toBe(UPLOAD_ID);
    expect(first).not.toBe(second);
  });

  it('claims the session under a lease before reading a chunk', async () => {
    await writeChunks();

    await complete();

    expect(claimForCompletion).toHaveBeenCalledWith(UPLOAD_ID, COMPLETION_LEASE_SECONDS);
    expect(claimForCompletion.mock.invocationCallOrder[0]).toBeLessThan(
      command.mock.invocationCallOrder[0] ?? 0,
    );
    // A completion that got through keeps nothing to give back.
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it('expires the session once the file exists, before the chunks are removed', async () => {
    await writeChunks();
    const order: string[] = [];
    const chunksPresent = (): string =>
      fs.existsSync(path.join(root, 'uploads', UPLOAD_ID)) ? 'chunks' : 'no chunks';
    expire.mockImplementation(() => {
      order.push(`expire: ${chunksPresent()}`);

      return Promise.resolve(true);
    });
    markPurged.mockImplementation(() => {
      order.push(`purge: ${chunksPresent()}`);

      return Promise.resolve(true);
    });

    await complete();

    expect(order).toEqual(['expire: chunks', 'purge: no chunks']);
  });

  it('leaves the session expired when removing the chunks fails after the file exists', async () => {
    // A retry after this must not assemble a second file: the session is already over, and
    // the worker collects what is left once the lease lapses.
    await writeChunks();
    jest.spyOn(storage, 'removeTree').mockRejectedValue(new Error('EIO'));

    await expect(complete()).rejects.toThrow('EIO');

    expect(command).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith(UPLOAD_ID);
    expect(releaseLease).not.toHaveBeenCalled();
    expect(markPurged).not.toHaveBeenCalled();
  });

  it('answers 409 while another completion holds the session, dispatching nothing', async () => {
    await writeChunks();
    claimForCompletion.mockResolvedValue(null);

    await expect(complete()).rejects.toThrow(
      new ConflictException('The upload is already being completed'),
    );

    expect(command).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    expect(chunksOnDisk()).toEqual(['0', '1', '2']);
  });

  it('answers 404 when the session lapsed between the read and the claim', async () => {
    await writeChunks();
    claimForCompletion.mockResolvedValue(null);
    findOwned.mockResolvedValueOnce(RECORD).mockResolvedValueOnce(null);

    await expect(complete()).rejects.toThrow(new NotFoundException('Upload not found'));

    expect(command).not.toHaveBeenCalled();
  });

  it('answers 409 when a chunk is missing, claiming and dispatching nothing', async () => {
    findOwned.mockResolvedValue({ ...RECORD, receivedChunks: [0, 2] });

    await expect(complete()).rejects.toThrow(new ConflictException('The upload is incomplete'));

    expect(claimForCompletion).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(markPurged).not.toHaveBeenCalled();
  });

  it('answers 409 when the assembled bytes do not add up to the declared size', async () => {
    // Every chunk present, but the last one short of what it was acknowledged as.
    await writeChunks([8, 8, 2]);

    await expect(complete()).rejects.toThrow(new ConflictException('The upload is incomplete'));

    expect(command).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledWith(CLAIMED);
    // The temp file is not left behind for a completion that failed.
    expect(fs.readdirSync(storage.tempDir())).toEqual([]);
  });

  it('leaves the session and its chunks intact, and releases the lease, when the upload is rejected', async () => {
    await writeChunks();
    command.mockRejectedValue(
      new UnsupportedMediaTypeException('That file type is not supported.'),
    );

    await expect(complete()).rejects.toThrow(UnsupportedMediaTypeException);

    expect(chunksOnDisk()).toEqual(['0', '1', '2']);
    expect(releaseLease).toHaveBeenCalledWith(CLAIMED);
    expect(expire).not.toHaveBeenCalled();
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

  function chunksOnDisk(): string[] {
    return fs.readdirSync(path.join(root, 'uploads', UPLOAD_ID)).toSorted();
  }
});
