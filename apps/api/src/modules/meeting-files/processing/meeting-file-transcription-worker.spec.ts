import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { EventBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import {
  MEETING_FILE_TRANSCRIPTION_FAILED_MESSAGE,
  MEETING_FILE_TRANSCRIPTION_REPEATED_FAILURE_MESSAGE,
  meetingFileTranscriptionTimeLimitMessage,
} from '@repo/shared';

import { MeetingFileChangedEvent } from '../events/meeting-file-changed.event';
import { TranscriptionStatus } from '../services/meeting-file-transcription-status';
import { MeetingFileTranscriptionRepository } from '../services/meeting-file-transcription.repository';
import type { ClaimedTranscription } from '../services/meeting-file-transcription.repository';
import { MeetingFileStorage } from '../storage/meeting-file-storage';
import {
  MEETING_FILE_TRANSCRIPTION_WORKER,
  MeetingFileTranscriptionWorker,
} from './meeting-file-transcription-worker';
import { TRANSCRIPTION_PROVIDER } from './transcription/transcription-provider';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const KEY = `${MEETING_ID}/${FILE_ID}`;
const TRANSCRIPT_KEY = `${KEY}.transcript.txt`;
const LEASE = new Date(Date.now() + 60_000);
const { QUEUED, TRANSCRIBING, TRANSCRIBED, FAILED } = TranscriptionStatus;
/** Words only the provider says; nothing the worker stores or announces may repeat them. */
const PROVIDER_WORDS = 'whisper said: CUDA out of memory at 0x7f3a';

const CLAIMED: ClaimedTranscription = {
  id: FILE_ID,
  meetingId: MEETING_ID,
  uploaderId: '11111111-1111-4111-8111-111111111111',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 10,
  storageKey: KEY,
  checksum: 'sha',
  thumbnailKey: null,
  transcriptKey: null,
  status: 'ready',
  failureReason: null,
  attempts: 1,
  leasedUntil: null,
  createdAt: new Date('2026-10-07T10:00:00.000Z'),
  processedAt: new Date('2026-10-07T10:00:01.000Z'),
  deletedAt: null,
  purgedAt: null,
  transcriptionStatus: TRANSCRIBING,
  previousTranscriptionStatus: QUEUED,
  transcriptionFailureReason: null,
  transcriptionAttempts: 1,
  transcriptionLeasedUntil: LEASE,
};

/** A provider that honours its signal, as the port requires, and never answers otherwise. */
const untilAborted = (_stream: Readable, _type: string, signal: AbortSignal): Promise<string> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(PROVIDER_WORDS)), { once: true });
  });

/**
 * What the worker decides: which claim is run, and what each way a run can end is recorded
 * as. The request itself is `transcription-run.spec.ts`'s, and the shape of each write and
 * announcement `transcription-outcome-recorder.spec.ts`'s.
 */
describe('MeetingFileTranscriptionWorker: one claim, start to finish', () => {
  const claimNext = jest.fn();
  const renewLease = jest.fn();
  const transition = jest.fn();
  const release = jest.fn();
  const openRead = jest.fn();
  const writeText = jest.fn();
  const publish = jest.fn();
  const transcribe = jest.fn();
  let worker: MeetingFileTranscriptionWorker;

  const build = async (
    overrides: Record<string, unknown> = {},
  ): Promise<MeetingFileTranscriptionWorker> => {
    const values: Record<string, unknown> = {
      MEETING_FILES_WORKER_ENABLED: false,
      MEETING_FILES_TRANSCRIPTION_ENABLED: true,
      MEETING_FILES_LEASE_SECONDS: 30,
      ...overrides,
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFileTranscriptionWorker,
        { provide: MEETING_FILE_TRANSCRIPTION_WORKER, useExisting: MeetingFileTranscriptionWorker },
        {
          provide: ConfigService,
          useValue: { get: (key: string, fallback: unknown) => values[key] ?? fallback },
        },
        {
          provide: MeetingFileTranscriptionRepository,
          useValue: { claimNext, renewLease, transition, release },
        },
        { provide: MeetingFileStorage, useValue: { openRead, writeText } },
        { provide: EventBus, useValue: { publish } },
        { provide: TRANSCRIPTION_PROVIDER, useValue: { transcribe } },
      ],
    }).compile();

    return moduleRef.get(MEETING_FILE_TRANSCRIPTION_WORKER);
  };

  /** The files the worker announced, in order, as the stream would carry them. */
  const announced = (): unknown[] =>
    publish.mock.calls.map(([event]: [MeetingFileChangedEvent]) => event.file);

  beforeEach(async () => {
    claimNext.mockReset().mockResolvedValueOnce(CLAIMED).mockResolvedValue(null);
    renewLease.mockReset().mockResolvedValue(new Date(Date.now() + 30_000));
    transition.mockReset().mockResolvedValue(true);
    release.mockReset().mockResolvedValue(true);
    openRead.mockReset().mockImplementation(() => new PassThrough());
    writeText.mockReset().mockResolvedValue(undefined);
    publish.mockReset();
    transcribe.mockReset().mockResolvedValue('Good morning, everyone.');
    worker = await build();
  });

  it('is reachable under its string token, claims under the configured lease, and counts what it handled', async () => {
    expect(worker).toBeInstanceOf(MeetingFileTranscriptionWorker);
    await expect(worker.drain()).resolves.toBe(1);

    expect(claimNext).toHaveBeenCalledWith(30);
    expect(openRead).toHaveBeenCalledWith(KEY);
  });

  it('takes a claim to transcribed: the transcript stored, the row written, both edges announced', async () => {
    await worker.drain();

    expect(writeText).toHaveBeenCalledWith(TRANSCRIPT_KEY, 'Good morning, everyone.');
    expect(transition).toHaveBeenCalledWith(
      FILE_ID,
      TRANSCRIBING,
      TRANSCRIBED,
      { transcriptKey: TRANSCRIPT_KEY },
      LEASE,
    );
    expect(transition).toHaveBeenCalledTimes(1);
    expect(announced()).toEqual([
      expect.objectContaining({ status: 'ready', transcriptionStatus: 'transcribing' }),
      expect.objectContaining({ status: 'ready', transcriptionStatus: 'transcribed' }),
    ]);
  });

  describe('when the provider fails', () => {
    beforeEach(() => {
      transcribe.mockRejectedValue(new Error(PROVIDER_WORDS));
    });

    it('fails the transcription with the generic sentence and stores no transcript', async () => {
      await worker.drain();

      expect(transition).toHaveBeenCalledWith(
        FILE_ID,
        TRANSCRIBING,
        FAILED,
        { transcriptionFailureReason: MEETING_FILE_TRANSCRIPTION_FAILED_MESSAGE },
        LEASE,
      );
      expect(transition).toHaveBeenCalledTimes(1);
      expect(writeText).not.toHaveBeenCalled();
      // The first error ends it: there is no second request behind the user's back.
      expect(transcribe).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
    });

    it('keeps the provider\u2019s own words out of everything it writes or announces', async () => {
      await worker.drain();

      expect(announced()[1]).toMatchObject({
        transcriptionStatus: 'failed',
        transcriptionFailureReason: MEETING_FILE_TRANSCRIPTION_FAILED_MESSAGE,
      });
      expect(JSON.stringify([transition.mock.calls, announced()])).not.toContain('whisper said');
    });
  });

  it('fails a transcription that outruns the time limit with a reason naming the limit', async () => {
    const limited = await build({ TRANSCRIPTION_TIMEOUT_SECONDS: 1 });
    transcribe.mockImplementation(untilAborted);

    await limited.drain();

    expect(transition).toHaveBeenCalledWith(
      FILE_ID,
      TRANSCRIBING,
      FAILED,
      { transcriptionFailureReason: 'Transcription took longer than the 1-second limit.' },
      LEASE,
    );
    // And in minutes when the limit is a whole number of them, as the default is.
    expect(meetingFileTranscriptionTimeLimitMessage(720)).toContain('the 12-minute limit');
    expect(meetingFileTranscriptionTimeLimitMessage(90)).toContain('the 90-second limit');
  });

  it('writes and announces nothing more once a renewal finds the claim gone', async () => {
    // Zero rows: the file was deleted, or the lease lapsed and another worker took the claim.
    renewLease.mockResolvedValue(null);
    const shortLease = await build({ MEETING_FILES_LEASE_SECONDS: 3 });
    transcribe.mockImplementation(untilAborted);

    await expect(shortLease.drain()).resolves.toBe(1);

    expect(writeText).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    // Only the claim itself was ever announced; the row is somebody else's now.
    expect(announced()).toHaveLength(1);
  });

  it('fails a transcription claimed a fourth time without running it', async () => {
    claimNext.mockReset().mockResolvedValueOnce({ ...CLAIMED, transcriptionAttempts: 4 });
    claimNext.mockResolvedValue(null);

    await worker.drain();

    expect(transcribe).not.toHaveBeenCalled();
    expect(openRead).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith(
      FILE_ID,
      TRANSCRIBING,
      FAILED,
      { transcriptionFailureReason: MEETING_FILE_TRANSCRIPTION_REPEATED_FAILURE_MESSAGE },
      LEASE,
    );
    expect(announced()[1]).toMatchObject({
      transcriptionStatus: 'failed',
      transcriptionFailureReason: MEETING_FILE_TRANSCRIPTION_REPEATED_FAILURE_MESSAGE,
    });
  });

  it('still runs a third claim: the cap is three, not two', async () => {
    claimNext.mockReset().mockResolvedValueOnce({ ...CLAIMED, transcriptionAttempts: 3 });
    claimNext.mockResolvedValue(null);

    await worker.drain();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls[0]?.[2]).toBe(TRANSCRIBED);
  });
});
