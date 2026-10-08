import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { EventBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import type { MeetingFileChangedEvent } from '../events/meeting-file-changed.event';
import { MeetingFileHandOvers } from '../services/meeting-file-hand-overs';
import { TranscriptionStatus } from '../services/meeting-file-transcription-status';
import { MeetingFileTranscriptionRepository } from '../services/meeting-file-transcription.repository';
import type { ClaimedTranscription } from '../services/meeting-file-transcription.repository';
import { buildMeetingFileRecord } from '../services/meeting-file-record.fixture';
import { MeetingFileStorage } from '../storage/meeting-file-storage';
import { MeetingFileTranscriptionWorker } from './meeting-file-transcription-worker';
import { TRANSCRIPTION_PROVIDER } from './transcription/transcription-provider';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const LEASE = new Date(Date.now() + 60_000);
const { QUEUED, TRANSCRIBING, TRANSCRIBED, FAILED } = TranscriptionStatus;

const CLAIMED: ClaimedTranscription = {
  ...buildMeetingFileRecord({
    id: FILE_ID,
    meetingId: MEETING_ID,
    name: 'standup.mp3',
    contentType: 'audio/mpeg',
    storageKey: `${MEETING_ID}/${FILE_ID}`,
    checksum: 'sha',
    status: 'ready',
    attempts: 1,
    processedAt: new Date('2026-10-07T10:00:01.000Z'),
    transcriptionStatus: TRANSCRIBING,
    transcriptionAttempts: 1,
    transcriptionLeasedUntil: LEASE,
  }),
  previousTranscriptionStatus: QUEUED,
};

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('MeetingFileTranscriptionWorker: polling and shutdown', () => {
  const claimNext = jest.fn();
  const transition = jest.fn();
  const release = jest.fn();
  const writeText = jest.fn();
  const remove = jest.fn();
  const publish = jest.fn();
  const transcribe = jest.fn();
  const started: MeetingFileTranscriptionWorker[] = [];

  const defaults: Record<string, unknown> = {
    MEETING_FILES_WORKER_ENABLED: false,
    MEETING_FILES_TRANSCRIPTION_ENABLED: true,
    MEETING_FILES_LEASE_SECONDS: 3,
    MEETING_FILES_POLL_MS: 20,
  };

  /** `values` is read on every `get`, not copied, so a test can change a setting in place. */
  const build = async (
    values: Record<string, unknown> = {},
  ): Promise<MeetingFileTranscriptionWorker> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFileTranscriptionWorker,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback: unknown) => values[key] ?? defaults[key] ?? fallback,
          },
        },
        {
          provide: MeetingFileTranscriptionRepository,
          useValue: { claimNext, transition, release },
        },
        {
          provide: MeetingFileStorage,
          useValue: { openRead: () => new PassThrough(), writeText, remove },
        },
        { provide: EventBus, useValue: { publish } },
        { provide: TRANSCRIPTION_PROVIDER, useValue: { transcribe } },
        MeetingFileHandOvers,
      ],
    }).compile();
    const worker = moduleRef.get(MeetingFileTranscriptionWorker);

    started.push(worker);

    return worker;
  };

  /**
   * A provider that answers only when told to, and rejects the moment its signal aborts — the
   * port's contract, and what a real request to a Whisper server does.
   */
  const slowProvider = (): { answer: (text: string) => void; signal: () => AbortSignal } => {
    const seen: { resolve?: (text: string) => void; signal?: AbortSignal } = {};

    transcribe.mockImplementation(
      (_stream: Readable, _type: string, signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          seen.signal = signal;
          seen.resolve = resolve;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );

    return {
      answer: (text) => seen.resolve?.(text),
      signal: () => seen.signal ?? new AbortController().signal,
    };
  };

  const statusesAnnounced = (): unknown[] =>
    publish.mock.calls.map(([event]: [MeetingFileChangedEvent]) => event.file.transcriptionStatus);

  beforeEach(() => {
    claimNext.mockReset().mockResolvedValueOnce(CLAIMED).mockResolvedValue(null);
    transition.mockReset().mockResolvedValue(true);
    release.mockReset().mockResolvedValue(true);
    writeText.mockReset().mockResolvedValue(undefined);
    remove.mockReset().mockResolvedValue(undefined);
    publish.mockReset();
    transcribe.mockReset().mockResolvedValue('Good morning, everyone.');
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((worker) => worker.onModuleDestroy()));
  });

  describe('polling', () => {
    it('claims nothing while the setting is off, however often it is asked', async () => {
      const worker = await build({ MEETING_FILES_TRANSCRIPTION_ENABLED: false });

      await expect(worker.tick()).resolves.toBe(false);
      await expect(worker.drain()).resolves.toBe(0);

      expect(claimNext).not.toHaveBeenCalled();
    });

    it('asks for the setting on every tick, so a queued row waits for it to come back', async () => {
      const values: Record<string, unknown> = { MEETING_FILES_TRANSCRIPTION_ENABLED: false };
      const worker = await build(values);

      await expect(worker.drain()).resolves.toBe(0);
      values['MEETING_FILES_TRANSCRIPTION_ENABLED'] = true;
      await expect(worker.drain()).resolves.toBe(1);

      expect(transition).toHaveBeenCalledWith(
        FILE_ID,
        TRANSCRIBING,
        TRANSCRIBED,
        expect.anything(),
        LEASE,
      );
    });

    it.each([
      // The e2e suite runs like this, and drains the worker by hand instead.
      ['the worker flag is off', { MEETING_FILES_WORKER_ENABLED: false }],
      [
        'transcription is switched off',
        { MEETING_FILES_WORKER_ENABLED: true, MEETING_FILES_TRANSCRIPTION_ENABLED: false },
      ],
    ])('does not poll on its own while %s', async (_label, values) => {
      const worker = await build(values);

      worker.onApplicationBootstrap();
      await settle(80);

      expect(claimNext).not.toHaveBeenCalled();
    });

    it('polls in a loop of its own once both are on, and keeps asking after an empty claim', async () => {
      const worker = await build({ MEETING_FILES_WORKER_ENABLED: true });

      worker.onApplicationBootstrap();
      await settle(120);

      expect(transition).toHaveBeenCalledTimes(1);
      expect(claimNext.mock.calls.length).toBeGreaterThan(2);
    });
  });

  describe('shutdown', () => {
    it('hangs up on the provider and hands the claim back, uncounted and unfailed', async () => {
      const worker = await build();
      const provider = slowProvider();
      const drained = worker.drain();
      await settle(20);

      await worker.onModuleDestroy();

      // The shutdown waited for the claim to be given back before it returned.
      expect(release).toHaveBeenCalledWith(FILE_ID, LEASE);
      expect(provider.signal().aborted).toBe(true);
      expect(transition).not.toHaveBeenCalledWith(
        FILE_ID,
        TRANSCRIBING,
        FAILED,
        expect.anything(),
        expect.anything(),
      );
      expect(statusesAnnounced()).toEqual(['transcribing', 'queued']);
      await expect(drained).resolves.toBe(1);
    });

    it('claims nothing more once it has begun, so the row it released is left for another process', async () => {
      const worker = await build();
      claimNext.mockReset().mockResolvedValue(CLAIMED);
      slowProvider();
      const drained = worker.drain();
      await settle(20);

      await worker.onModuleDestroy();

      await expect(drained).resolves.toBe(1);
      expect(claimNext).toHaveBeenCalledTimes(1);
      await expect(worker.tick()).resolves.toBe(false);
    });

    it('still records a transcript that arrived as the shutdown began', async () => {
      const worker = await build();
      const provider = slowProvider();
      const drained = worker.drain();
      await settle(20);

      provider.answer('Just in time.');
      await worker.onModuleDestroy();
      await drained;

      expect(release).not.toHaveBeenCalled();
      expect(statusesAnnounced()).toEqual(['transcribing', 'transcribed']);
    });
  });
});
