import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ConfigService } from '@nestjs/config';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { MeetingFileUploadHoldRepository } from '../../services/meeting-file-upload-hold.repository';
import { MeetingFileUploadRepository } from '../../services/meeting-file-upload.repository';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { StoreChunkCommand } from '../store-chunk.command';
import { StoreChunkHandler } from './store-chunk.handler';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const UPLOAD_ID = '55555555-5555-4555-8555-555555555555';

/** Three chunks: two whole ones of eight bytes, then the four that are left. */
const SESSION = { id: UPLOAD_ID, size: 20, chunkSize: 8, chunkCount: 3 };

const EXPIRED = new Error('Transaction already closed: the timeout for this transaction passed');

type Write = () => Promise<void>;

/**
 * A hold has a time limit, and running out of it does not stop the move it was guarding. The
 * move then finishes with no lock held — and if the session ended in that gap, after the
 * worker's purge, where nothing would remove what it leaves. These hold the handler to
 * cleaning up after a hold that failed.
 */
describe('StoreChunkHandler, when a hold fails with a move under way', () => {
  const whileLive = jest.fn();
  const isLive = jest.fn();
  const addReceivedChunk = jest.fn();
  let root: string;
  let storage: MeetingFileStorage;
  let handler: StoreChunkHandler;

  const store = (): Promise<void> =>
    handler.execute(new StoreChunkCommand(USER_ID, MEETING_ID, UPLOAD_ID, 0, Buffer.alloc(8, 1)));
  const sessionTree = (): string => path.join(root, 'uploads', UPLOAD_ID);

  beforeEach(async () => {
    // The hold as it ends when its time runs out: the move finishes, and only then does the
    // transaction report that it is no longer there to commit.
    whileLive.mockReset().mockImplementation(async (_uploadId: string, write: Write) => {
      await write();

      throw EXPIRED;
    });
    isLive.mockReset().mockResolvedValue(false);
    addReceivedChunk.mockReset();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-chunk-lost-hold-'));
    storage = new MeetingFileStorage({ getOrThrow: () => root } as unknown as ConfigService);
    await storage.onModuleInit();

    const moduleRef = await Test.createTestingModule({
      providers: [
        StoreChunkHandler,
        { provide: QueryBus, useValue: { execute: () => Promise.resolve({ id: MEETING_ID }) } },
        {
          provide: MeetingFileUploadRepository,
          useValue: { findOwned: () => Promise.resolve(SESSION), addReceivedChunk },
        },
        { provide: MeetingFileUploadHoldRepository, useValue: { whileLive, isLive } },
        { provide: MeetingFileStorage, useValue: storage },
      ],
    })
      .setLogger({ log: jest.fn(), error: jest.fn(), warn: jest.fn() })
      .compile();

    handler = moduleRef.get(StoreChunkHandler);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('removes the tree of a session that ended while the move was unheld', async () => {
    await expect(store()).rejects.toBe(EXPIRED);

    expect(isLive).toHaveBeenCalledWith(UPLOAD_ID);
    // The chunk did land, after the purge had been: nothing else would ever remove it.
    expect(fs.existsSync(sessionTree())).toBe(false);
    expect(fs.readdirSync(storage.tempDir())).toEqual([]);
    expect(addReceivedChunk).not.toHaveBeenCalled();
  });

  it('leaves the chunk of a session that is still live, for that session’s own purge', async () => {
    isLive.mockResolvedValue(true);

    await expect(store()).rejects.toBe(EXPIRED);

    expect(fs.readdirSync(sessionTree())).toEqual(['0']);
    expect(addReceivedChunk).not.toHaveBeenCalled();
  });

  // The other way a hold can fail: reported at once, with the move still on its way. Judged
  // then, there is nothing to remove yet — and the chunk arrives afterwards.
  it('waits for a move that is still running before it judges what was left', async () => {
    whileLive.mockImplementation((_uploadId: string, write: Write) => {
      void write();

      return Promise.reject(EXPIRED);
    });

    await expect(store()).rejects.toBe(EXPIRED);

    expect(fs.existsSync(sessionTree())).toBe(false);
  });

  it('asks nothing about the session when no move was started', async () => {
    whileLive.mockRejectedValue(EXPIRED);

    await expect(store()).rejects.toBe(EXPIRED);

    expect(isLive).not.toHaveBeenCalled();
  });

  it('still reports the hold’s failure when the session cannot be asked about', async () => {
    isLive.mockRejectedValue(new Error('the database is not answering'));

    await expect(store()).rejects.toBe(EXPIRED);
  });
});
