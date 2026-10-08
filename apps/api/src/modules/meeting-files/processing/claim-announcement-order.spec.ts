import { PassThrough } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { EventBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import type { MeetingFileChangedEvent } from '../events/meeting-file-changed.event';
import { holdWrite, nextTurn } from '../services/held-write.fixture';
import { MeetingFileHandOvers } from '../services/meeting-file-hand-overs';
import { buildMeetingFileRecord } from '../services/meeting-file-record.fixture';
import { TranscriptionStatus } from '../services/meeting-file-transcription-status';
import { MeetingFileTranscriptionRepository } from '../services/meeting-file-transcription.repository';
import type { ClaimedTranscription } from '../services/meeting-file-transcription.repository';
import { MeetingFileUploadRepository } from '../services/meeting-file-upload.repository';
import { MeetingFileRepository } from '../services/meeting-file.repository';
import type { ClaimedFile } from '../services/meeting-file.repository';
import { MeetingFileStorage } from '../storage/meeting-file-storage';
import { MeetingFileTranscriptionWorker } from './meeting-file-transcription-worker';
import { MeetingFileWorker, PIPELINE_STEPS } from './meeting-file-worker';
import { TRANSCRIPTION_PROVIDER } from './transcription/transcription-provider';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const LEASE = new Date(Date.now() + 60_000);
const RECORDING = {
  id: FILE_ID,
  meetingId: MEETING_ID,
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  storageKey: `${MEETING_ID}/${FILE_ID}`,
};

const CLAIMED_FILE: ClaimedFile = {
  ...buildMeetingFileRecord({
    ...RECORDING,
    status: 'processing',
    attempts: 1,
    leasedUntil: LEASE,
  }),
  previousStatus: 'uploaded',
};

const CLAIMED_TRANSCRIPTION: ClaimedTranscription = {
  ...buildMeetingFileRecord({
    ...RECORDING,
    status: 'ready',
    transcriptionStatus: TranscriptionStatus.TRANSCRIBING,
    transcriptionAttempts: 1,
    transcriptionLeasedUntil: LEASE,
  }),
  previousTranscriptionStatus: TranscriptionStatus.QUEUED,
};

const settings = (values: Record<string, unknown>) => ({
  provide: ConfigService,
  useValue: { get: (key: string, fallback: unknown) => values[key] ?? fallback },
});

/**
 * The inversion the hand-overs exist for, made to happen on purpose: a claim that comes back
 * while the announcement of the write before it is still on its way. `claimNext` answering
 * while a hand-over is held open is exactly that moment — by timing alone it is one run in
 * a few hundred.
 */
describe('a claim’s announcement and the hand-over before it', () => {
  const claimNext = jest.fn();
  const transition = jest.fn();
  const publish = jest.fn();
  let handOvers: MeetingFileHandOvers;
  let order: string[];

  /** A handler's hand-over of the file, held between its write and its announcement. */
  const holdHandOver = (announcement: string): { finish(): void } => {
    const write = holdWrite();

    void handOvers.run(FILE_ID, async () => {
      await write.answered;
      order.push(announcement);
    });

    return { finish: () => write.answer() };
  };

  beforeEach(() => {
    order = [];
    claimNext.mockReset().mockResolvedValue(null);
    transition.mockReset().mockResolvedValue(true);
    publish.mockReset().mockImplementation(({ file }: MeetingFileChangedEvent) => {
      order.push(file.transcriptionStatus ?? file.status);
    });
  });

  describe('the file worker', () => {
    let worker: MeetingFileWorker;

    beforeEach(async () => {
      claimNext.mockResolvedValueOnce(CLAIMED_FILE);
      const moduleRef = await Test.createTestingModule({
        providers: [
          MeetingFileWorker,
          MeetingFileHandOvers,
          settings({ MEETING_FILES_WORKER_ENABLED: false }),
          {
            provide: MeetingFileRepository,
            useValue: { claimNext, transition, renewLease: jest.fn().mockResolvedValue(LEASE) },
          },
          {
            provide: MeetingFileUploadRepository,
            useValue: { claimExpired: jest.fn().mockResolvedValue(null) },
          },
          { provide: MeetingFileStorage, useValue: {} },
          { provide: EventBus, useValue: { publish } },
          { provide: PIPELINE_STEPS, useValue: [] },
        ],
      }).compile();

      worker = moduleRef.get(MeetingFileWorker);
      handOvers = moduleRef.get(MeetingFileHandOvers);
    });

    it('announces its claim only once the upload that handed it the file has been', async () => {
      const upload = holdHandOver('uploaded');
      const drained = worker.drain();

      await nextTurn();
      // The claim is back, and nothing is said: "uploaded" after "processing", or after
      // "ready", would leave a page on Processing for a file that is done.
      expect(claimNext).toHaveBeenCalled();
      expect(order).toEqual([]);

      upload.finish();
      await drained;

      expect(order).toEqual(['uploaded', 'processing', 'ready']);
    });

    it('hands a file over with its `ready`, which is the write that queues a recording', async () => {
      const write = holdWrite<boolean>();
      transition.mockReturnValue(write.answered);
      const drained = worker.drain();
      await nextTurn();

      // The transcription worker's side: its claim of this row came back just now.
      const claimed = handOvers.announced(FILE_ID).then(() => order.push('transcribing'));
      await nextTurn();
      expect(order).toEqual(['processing']);

      write.answer(true);
      await Promise.all([drained, claimed]);

      expect(order).toEqual(['processing', 'ready', 'transcribing']);
    });
  });

  describe('the transcription worker', () => {
    const transcribe = jest.fn();
    let worker: MeetingFileTranscriptionWorker;

    beforeEach(async () => {
      claimNext.mockResolvedValueOnce(CLAIMED_TRANSCRIPTION);
      transcribe.mockReset().mockResolvedValue('Good morning, everyone.');
      const moduleRef = await Test.createTestingModule({
        providers: [
          MeetingFileTranscriptionWorker,
          MeetingFileHandOvers,
          settings({
            MEETING_FILES_WORKER_ENABLED: false,
            MEETING_FILES_TRANSCRIPTION_ENABLED: true,
          }),
          {
            provide: MeetingFileTranscriptionRepository,
            useValue: { claimNext, transition, renewLease: jest.fn().mockResolvedValue(LEASE) },
          },
          {
            provide: MeetingFileStorage,
            useValue: { openRead: () => new PassThrough(), writeText: jest.fn() },
          },
          { provide: EventBus, useValue: { publish } },
          { provide: TRANSCRIPTION_PROVIDER, useValue: { transcribe } },
        ],
      }).compile();

      worker = moduleRef.get(MeetingFileTranscriptionWorker);
      handOvers = moduleRef.get(MeetingFileHandOvers);
    });

    it('announces its claim only once the write that queued the recording has been', async () => {
      const queueing = holdHandOver('queued');
      const drained = worker.drain();

      await nextTurn();
      // The claim is back, and nothing is said: "queued" arriving after "transcribing" is
      // what a page would then show for as long as the transcription runs.
      expect(claimNext).toHaveBeenCalled();
      expect(order).toEqual([]);
      expect(transcribe).not.toHaveBeenCalled();

      queueing.finish();
      await drained;

      expect(order).toEqual(['queued', 'transcribing', 'transcribed']);
    });

    it('announces at once when nothing is in flight for the recording', async () => {
      await worker.drain();

      expect(order).toEqual(['transcribing', 'transcribed']);
    });
  });
});
