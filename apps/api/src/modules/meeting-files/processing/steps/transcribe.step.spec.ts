import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { StepError } from '../step';
import type { TranscriptionProvider } from '../transcription/transcription-provider';
import { TranscribeStep } from './transcribe.step';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const KEY = `${MEETING_ID}/${FILE_ID}`;

describe('TranscribeStep', () => {
  const logger = new Logger('test');
  const transcribe = jest.fn();
  const provider: TranscriptionProvider = { transcribe };
  let root: string;
  let storage: MeetingFileStorage;

  const record = (contentType: string): MeetingFileRecord => ({
    id: FILE_ID,
    meetingId: MEETING_ID,
    uploaderId: '11111111-1111-4111-8111-111111111111',
    name: 'standup',
    contentType,
    size: 12,
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

  const step = (values: Record<string, unknown>): TranscribeStep =>
    new TranscribeStep(
      {
        get: (key: string, fallback: unknown) => values[key] ?? fallback,
      } as unknown as ConfigService,
      provider,
    );

  const on = { MEETING_FILES_TRANSCRIPTION_ENABLED: true };

  beforeEach(async () => {
    transcribe.mockReset().mockResolvedValue('Good morning, everyone.');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-step-'));
    storage = new MeetingFileStorage({
      getOrThrow: () => root,
    } as unknown as ConfigService);
    await storage.onModuleInit();
    fs.mkdirSync(path.join(root, MEETING_ID), { recursive: true });
    fs.writeFileSync(storage.pathOf(KEY), 'audio bytes');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the transcript beside the object and returns its key', async () => {
    await expect(step(on).run({ record: record('audio/mpeg'), storage, logger })).resolves.toEqual({
      transcriptKey: `${KEY}.transcript.txt`,
    });

    expect(fs.readFileSync(storage.pathOf(`${KEY}.transcript.txt`), 'utf8')).toBe(
      'Good morning, everyone.',
    );
    const [stream, contentType, signal] = transcribe.mock.calls[0] as [
      Readable,
      string,
      AbortSignal,
    ];
    expect(contentType).toBe('audio/mpeg');
    // A stream, not a buffer: a gigabyte of video must not be read into memory to be sent.
    expect(typeof stream.pipe).toBe('function');
    // And a bound on it, so a provider that never answers cannot hold the row for ever.
    expect(signal.aborted).toBe(false);
  });

  it('transcribes video as well as audio', async () => {
    await expect(step(on).run({ record: record('video/mp4'), storage, logger })).resolves.toEqual({
      transcriptKey: `${KEY}.transcript.txt`,
    });
  });

  it.each([['application/pdf'], ['image/png'], ['text/plain']])(
    'skips %s without calling the provider',
    async (contentType) => {
      await expect(step(on).run({ record: record(contentType), storage, logger })).resolves.toEqual(
        {},
      );

      expect(transcribe).not.toHaveBeenCalled();
      expect(fs.existsSync(storage.pathOf(`${KEY}.transcript.txt`))).toBe(false);
    },
  );

  it('skips everything while the flag is off — a skip, never a failure', async () => {
    await expect(step({}).run({ record: record('audio/mpeg'), storage, logger })).resolves.toEqual(
      {},
    );

    expect(transcribe).not.toHaveBeenCalled();
  });

  it('reads the flag when it runs, so turning it on needs no restart', async () => {
    const values: Record<string, unknown> = { MEETING_FILES_TRANSCRIPTION_ENABLED: false };
    const perTick = step(values);

    await expect(perTick.run({ record: record('audio/mpeg'), storage, logger })).resolves.toEqual(
      {},
    );

    values['MEETING_FILES_TRANSCRIPTION_ENABLED'] = true;

    await expect(perTick.run({ record: record('audio/mpeg'), storage, logger })).resolves.toEqual({
      transcriptKey: `${KEY}.transcript.txt`,
    });
  });

  it("lets the provider's StepError through, so the row carries its reason", async () => {
    transcribe.mockRejectedValue(new StepError('The recording could not be transcribed'));

    await expect(step(on).run({ record: record('audio/mpeg'), storage, logger })).rejects.toThrow(
      'The recording could not be transcribed',
    );

    expect(fs.existsSync(storage.pathOf(`${KEY}.transcript.txt`))).toBe(false);
  });

  it('bounds the request with the configured timeout, so a hanging provider still fails', async () => {
    // Seconds, as the environment states them — 0.05 here only because a spec cannot wait out
    // the contract's thirty second floor. What it pins is that the step arms the signal at all.
    transcribe.mockImplementation(
      (stream: Readable, _contentType: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            stream.destroy();
            reject(new StepError('The recording could not be transcribed'));
          });
        }),
    );

    await expect(
      step({ ...on, TRANSCRIPTION_TIMEOUT_SECONDS: 0.05 }).run({
        record: record('audio/mpeg'),
        storage,
        logger,
      }),
    ).rejects.toThrow('The recording could not be transcribed');

    expect(fs.existsSync(storage.pathOf(`${KEY}.transcript.txt`))).toBe(false);
  });
});
