import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { StepError } from '../step';
import { VerifyStep } from './verify.step';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';

describe('VerifyStep', () => {
  const step = new VerifyStep();
  const logger = new Logger('test');
  let root: string;
  let storage: MeetingFileStorage;
  const bytes = Buffer.from('the quick brown fox');

  const record = (size: number): MeetingFileRecord => ({
    id: FILE_ID,
    meetingId: MEETING_ID,
    uploaderId: '11111111-1111-4111-8111-111111111111',
    name: 'fox.txt',
    contentType: 'text/plain',
    size,
    storageKey: `${MEETING_ID}/${FILE_ID}`,
    checksum: null,
    thumbnailKey: null,
    status: 'processing',
    failureReason: null,
    attempts: 1,
    leasedUntil: null,
    createdAt: new Date(),
    processedAt: null,
    deletedAt: null,
    purgedAt: null,
  });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-step-'));
    storage = new MeetingFileStorage({ getOrThrow: () => root } as unknown as ConfigService);
    await storage.onModuleInit();
    const source = path.join(storage.tempDir(), 'upload');
    fs.writeFileSync(source, bytes);
    await storage.put(`${MEETING_ID}/${FILE_ID}`, source);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is named verify', () => {
    expect(step.name).toBe('verify');
  });

  it('returns the SHA-256 of the stored bytes when the size matches', async () => {
    await expect(step.run({ record: record(bytes.length), storage, logger })).resolves.toEqual({
      checksum: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('throws the incomplete StepError on a size mismatch', async () => {
    await expect(step.run({ record: record(bytes.length + 1), storage, logger })).rejects.toThrow(
      new StepError('The stored file is incomplete'),
    );
  });

  it('lets a missing object surface as a plain error, not a user message', async () => {
    await storage.remove(`${MEETING_ID}/${FILE_ID}`);

    await expect(
      step.run({ record: record(bytes.length), storage, logger }),
    ).rejects.not.toBeInstanceOf(StepError);
  });
});
