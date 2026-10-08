import { PassThrough } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { EventBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { MEETING_FILE_TRANSCRIPTION_FAILED_MESSAGE } from '@repo/shared';

import { holdWrite } from '../services/held-write.fixture';
import { MeetingFileHandOvers } from '../services/meeting-file-hand-overs';
import { buildMeetingFileRecord } from '../services/meeting-file-record.fixture';
import { TranscriptionStatus } from '../services/meeting-file-transcription-status';
import { MeetingFileTranscriptionRepository } from '../services/meeting-file-transcription.repository';
import type { ClaimedTranscription } from '../services/meeting-file-transcription.repository';
import { MeetingFileStorage } from '../storage/meeting-file-storage';
import { MeetingFileTranscriptionWorker } from './meeting-file-transcription-worker';
import { TRANSCRIPTION_PROVIDER } from './transcription/transcription-provider';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const LEASE = new Date(Date.now() + 60_000);
const { QUEUED, TRANSCRIBING, FAILED } = TranscriptionStatus;

const CLAIMED: ClaimedTranscription = {
  ...buildMeetingFileRecord({
    id: FILE_ID,
    meetingId: MEETING_ID,
    name: 'standup.mp3',
    contentType: 'audio/mpeg',
    storageKey: `${MEETING_ID}/${FILE_ID}`,
    status: 'ready',
    transcriptionStatus: TRANSCRIBING,
    transcriptionAttempts: 1,
    transcriptionLeasedUntil: LEASE,
  }),
  previousTranscriptionStatus: QUEUED,
};

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A shutdown that begins after the provider has already failed. The spec beside this one has
 * the shutdown that interrupts a request; it is at the size limit, which is why this is a
 * file of its own.
 */
describe('MeetingFileTranscriptionWorker: a shutdown that arrives after the error', () => {
  const claimNext = jest.fn();
  const transition = jest.fn();
  const release = jest.fn();
  const renewLease = jest.fn();
  const transcribe = jest.fn();
  let worker: MeetingFileTranscriptionWorker;

  beforeEach(async () => {
    claimNext.mockReset().mockResolvedValueOnce(CLAIMED).mockResolvedValue(null);
    transition.mockReset().mockResolvedValue(true);
    release.mockReset().mockResolvedValue(true);
    const settings: Record<string, unknown> = {
      MEETING_FILES_WORKER_ENABLED: false,
      MEETING_FILES_TRANSCRIPTION_ENABLED: true,
      MEETING_FILES_LEASE_SECONDS: 3,
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFileTranscriptionWorker,
        MeetingFileHandOvers,
        {
          provide: ConfigService,
          useValue: { get: (key: string, fallback: unknown) => settings[key] ?? fallback },
        },
        {
          provide: MeetingFileTranscriptionRepository,
          useValue: { claimNext, transition, release, renewLease },
        },
        { provide: MeetingFileStorage, useValue: { openRead: () => new PassThrough() } },
        { provide: EventBus, useValue: { publish: jest.fn() } },
        { provide: TRANSCRIPTION_PROVIDER, useValue: { transcribe } },
      ],
    }).compile();

    worker = moduleRef.get(MeetingFileTranscriptionWorker);
  });

  it('records the failure, and does not hand the claim back for another attempt', async () => {
    const provider: { fail?: (error: Error) => void } = {};
    const renewal = holdWrite<Date>();
    const renewed = new Date(Date.now() + 3_000);
    renewLease.mockReset().mockReturnValue(renewal.answered);
    transcribe.mockReset().mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          provider.fail = reject;
        }),
    );

    // A renewal goes out a second in and stays out. The provider fails; the process then
    // starts to shut down, while the heartbeat is still waiting for that renewal to come back.
    const drained = worker.drain();
    await settle(1_100);
    provider.fail?.(new Error('refused'));
    await settle(20);
    const stopped = worker.onModuleDestroy();
    renewal.answer(renewed);
    await Promise.all([drained, stopped]);

    // The provider's error ended the request, so it is a failure the user is shown and may
    // retry — not a claim released for the next process to run again unasked.
    expect(transition).toHaveBeenCalledWith(
      FILE_ID,
      TRANSCRIBING,
      FAILED,
      { transcriptionFailureReason: MEETING_FILE_TRANSCRIPTION_FAILED_MESSAGE },
      renewed,
    );
    expect(release).not.toHaveBeenCalled();
  });
});
