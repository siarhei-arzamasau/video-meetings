import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BadRequestException,
  ConflictException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { ContentSniffer } from '../../services/content-sniffer';
import { MeetingFileRepository } from '../../services/meeting-file.repository';
import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { UploadMeetingFileCommand } from '../upload-meeting-file.command';
import { UploadMeetingFileHandler } from './upload-meeting-file.handler';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

const MEETING = {
  id: MEETING_ID,
  title: 'Engine review',
  status: 'scheduled',
  hostId: USER_ID,
  scheduledAt: '2026-08-01T10:00:00.000Z',
  participantIds: [],
};

describe('UploadMeetingFileHandler', () => {
  const execute = jest.fn();
  const createWithinCap = jest.fn();
  const put = jest.fn();
  const remove = jest.fn();
  const sniff = jest.fn();
  let handler: UploadMeetingFileHandler;
  let scratch: string;
  let tempPath: string;

  beforeEach(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-handler-'));
    tempPath = path.join(scratch, 'upload');
    fs.writeFileSync(tempPath, 'bytes');

    execute.mockReset().mockResolvedValue(MEETING);
    createWithinCap.mockReset().mockImplementation(
      async (data: Partial<MeetingFileRecord>): Promise<MeetingFileRecord> => ({
        id: data.id ?? '',
        meetingId: data.meetingId ?? '',
        uploaderId: data.uploaderId ?? '',
        name: data.name ?? '',
        contentType: data.contentType ?? '',
        size: data.size ?? 0,
        storageKey: data.storageKey ?? '',
        checksum: null,
        thumbnailKey: null,
        status: 'uploaded',
        failureReason: null,
        attempts: 0,
        leasedUntil: null,
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
        processedAt: null,
        deletedAt: null,
        purgedAt: null,
      }),
    );
    // A real `put` renames; the fake does the same so the temp-file assertions mean something.
    put.mockReset().mockImplementation(async (_key: string, source: string) => {
      fs.renameSync(source, path.join(scratch, 'stored'));
    });
    remove.mockReset().mockResolvedValue(undefined);
    sniff.mockReset().mockResolvedValue('application/pdf');

    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadMeetingFileHandler,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileRepository, useValue: { createWithinCap } },
        { provide: MeetingFileStorage, useValue: { put, remove } },
        { provide: ContentSniffer, useValue: { sniff } },
      ],
    }).compile();

    handler = moduleRef.get(UploadMeetingFileHandler);
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const command = (overrides: Partial<UploadMeetingFileCommand> = {}): UploadMeetingFileCommand =>
    new UploadMeetingFileCommand(
      overrides.userId ?? USER_ID,
      overrides.meetingId ?? MEETING_ID,
      overrides.originalName ?? ' deck.pdf ',
      overrides.tempPath ?? tempPath,
      overrides.size ?? 5,
    );

  it('sniffs, puts the bytes under <meetingId>/<fileId>, then inserts within the cap', async () => {
    const file = await handler.execute(command());

    expect(sniff).toHaveBeenCalledWith(tempPath, 'deck.pdf');
    expect(put).toHaveBeenCalledWith(`${MEETING_ID}/${file.id}`, tempPath);
    expect(createWithinCap).toHaveBeenCalledWith(
      {
        id: file.id,
        meetingId: MEETING_ID,
        uploaderId: USER_ID,
        name: 'deck.pdf',
        contentType: 'application/pdf',
        size: 5,
        storageKey: `${MEETING_ID}/${file.id}`,
      },
      50,
    );
    expect(file).toMatchObject({
      name: 'deck.pdf',
      contentType: 'application/pdf',
      status: 'uploaded',
    });
    // The insert follows the rename, never the other way round.
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(
      createWithinCap.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('answers 404 for an invisible meeting before reading the bytes, and removes the temp file', async () => {
    execute.mockResolvedValue(null);

    await expect(handler.execute(command())).rejects.toMatchObject({ status: 404 });

    expect(sniff).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('rejects a bad name with 400 and removes the temp file', async () => {
    await expect(handler.execute(command({ originalName: 'a/b.pdf' }))).rejects.toThrow(
      new BadRequestException(
        'The file name must be 1–255 characters and contain no path separators',
      ),
    );

    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('rejects an empty file with 400', async () => {
    await expect(handler.execute(command({ size: 0 }))).rejects.toThrow(
      new BadRequestException('The file is empty'),
    );

    expect(sniff).not.toHaveBeenCalled();
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('rejects an unsupported type with 415 and removes the temp file', async () => {
    sniff.mockResolvedValue(null);

    await expect(handler.execute(command())).rejects.toThrow(
      new UnsupportedMediaTypeException('That file type is not supported.'),
    );

    expect(put).not.toHaveBeenCalled();
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('answers 409 at the cap and removes the object it had already put', async () => {
    createWithinCap.mockResolvedValue(null);

    await expect(handler.execute(command())).rejects.toThrow(
      new ConflictException('This meeting already has 50 files.'),
    );

    const [storageKey] = put.mock.calls[0] as [string, string];
    expect(remove).toHaveBeenCalledWith(storageKey);
  });

  it('rethrows an insert failure after removing the object, so bytes never outlive a failed record', async () => {
    createWithinCap.mockRejectedValue(new Error('connection lost'));

    await expect(handler.execute(command())).rejects.toThrow('connection lost');

    const [storageKey] = put.mock.calls[0] as [string, string];
    expect(remove).toHaveBeenCalledWith(storageKey);
  });

  it('rethrows a storage failure and writes no record', async () => {
    put.mockRejectedValue(new Error('disk full'));

    await expect(handler.execute(command())).rejects.toThrow('disk full');

    expect(createWithinCap).not.toHaveBeenCalled();
    expect(fs.existsSync(tempPath)).toBe(false);
  });
});
