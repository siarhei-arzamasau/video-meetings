import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';

import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { PreviewStep } from './preview.step';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const KEY = `${MEETING_ID}/${FILE_ID}`;

/** A context signal nothing aborts: the step under test is the only thing that can end it. */
const NEVER_ABORTED = new AbortController().signal;

describe('PreviewStep', () => {
  const step = new PreviewStep();
  const logger = new Logger('test');
  let root: string;
  let storage: MeetingFileStorage;

  const record = (contentType: string, size: number): MeetingFileRecord => ({
    id: FILE_ID,
    meetingId: MEETING_ID,
    uploaderId: '11111111-1111-4111-8111-111111111111',
    name: 'photo',
    contentType,
    size,
    storageKey: KEY,
    checksum: null,
    thumbnailKey: null,
    transcriptKey: null,
    status: 'processing',
    failureReason: null,
    attempts: 1,
    leasedUntil: null,
    createdAt: new Date(),
    processedAt: null,
    deletedAt: null,
    purgedAt: null,
  });

  const store = async (bytes: Buffer): Promise<void> => {
    const source = path.join(storage.tempDir(), 'upload');
    fs.writeFileSync(source, bytes);
    await storage.put(KEY, source);
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-step-'));
    storage = new MeetingFileStorage({ getOrThrow: () => root } as unknown as ConfigService);
    await storage.onModuleInit();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is named preview', () => {
    expect(step.name).toBe('preview');
  });

  it('is a no-op for anything that is not an image', async () => {
    await store(Buffer.from('%PDF-1.4'));

    await expect(
      step.run({ record: record('application/pdf', 8), storage, logger, signal: NEVER_ABORTED }),
    ).resolves.toEqual({});
    expect(fs.existsSync(storage.pathOf(`${KEY}.thumb.webp`))).toBe(false);
  });

  it('writes a WebP no larger than 320px on its longest side beside the original', async () => {
    const png = await sharp({
      create: { width: 800, height: 400, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .png()
      .toBuffer();
    await store(png);

    await expect(
      step.run({ record: record('image/png', png.length), storage, logger, signal: NEVER_ABORTED }),
    ).resolves.toEqual({
      thumbnailKey: `${KEY}.thumb.webp`,
    });

    const thumbnail = await sharp(storage.pathOf(`${KEY}.thumb.webp`)).metadata();
    expect(thumbnail.format).toBe('webp');
    expect(thumbnail.width).toBe(320);
    expect(thumbnail.height).toBe(160);
  });

  it('does not enlarge a small image', async () => {
    const png = await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    await store(png);

    await step.run({
      record: record('image/png', png.length),
      storage,
      logger,
      signal: NEVER_ABORTED,
    });

    const thumbnail = await sharp(storage.pathOf(`${KEY}.thumb.webp`)).metadata();
    expect([thumbnail.width, thumbnail.height]).toEqual([40, 30]);
  });

  it('throws the unreadable StepError when the bytes cannot be decoded', async () => {
    await store(Buffer.from('not an image at all'));

    await expect(
      step.run({ record: record('image/png', 19), storage, logger, signal: NEVER_ABORTED }),
    ).rejects.toMatchObject({
      name: 'StepError',
      userMessage: 'The image could not be read',
    });
  });
});
