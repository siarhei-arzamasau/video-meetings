import { Logger } from '@nestjs/common';
import type { EventBus } from '@nestjs/cqrs';

import { MeetingFileChangedEvent } from '../../events/meeting-file-changed.event';
import { TranscriptionStatus } from '../../services/meeting-file-transcription-status';
import type {
  ClaimedTranscription,
  MeetingFileTranscriptionRepository,
} from '../../services/meeting-file-transcription.repository';
import { buildMeetingFileRecord } from '../../services/meeting-file-record.fixture';
import type { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { TranscriptionOutcomeRecorder } from './transcription-outcome-recorder';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const KEY = `${MEETING_ID}/${FILE_ID}`;
const TRANSCRIPT_KEY = `${KEY}.transcript.txt`;
const LEASE = new Date(Date.now() + 60_000);
const STARTED_AT = Date.now();
const { QUEUED, TRANSCRIBING, TRANSCRIBED, FAILED } = TranscriptionStatus;

const CLAIMED: ClaimedTranscription = {
  ...buildMeetingFileRecord({
    id: FILE_ID,
    meetingId: MEETING_ID,
    name: 'standup.mp3',
    contentType: 'audio/mpeg',
    storageKey: KEY,
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

describe('TranscriptionOutcomeRecorder', () => {
  const transition = jest.fn();
  const release = jest.fn();
  const isFileReady = jest.fn();
  const writeText = jest.fn();
  const remove = jest.fn();
  const publish = jest.fn();
  const recorder = new TranscriptionOutcomeRecorder(
    { transition, release, isFileReady } as unknown as MeetingFileTranscriptionRepository,
    { writeText, remove } as unknown as MeetingFileStorage,
    { publish } as unknown as EventBus,
    new Logger('test'),
  );

  /** The files announced, in order, as the stream would carry them. */
  const announced = (): unknown[] =>
    publish.mock.calls.map(([event]: [MeetingFileChangedEvent]) => event.file);

  beforeEach(() => {
    transition.mockReset().mockResolvedValue(true);
    release.mockReset().mockResolvedValue(true);
    isFileReady.mockReset().mockResolvedValue(false);
    writeText.mockReset().mockResolvedValue(undefined);
    remove.mockReset().mockResolvedValue(undefined);
    publish.mockReset();
  });

  it('announces a claim as transcribing, on the meeting it belongs to, with no write of its own', () => {
    recorder.claimed(CLAIMED, STARTED_AT);

    expect(publish.mock.calls[0]?.[0]).toBeInstanceOf(MeetingFileChangedEvent);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ meetingId: MEETING_ID });
    expect(announced()).toEqual([
      expect.objectContaining({
        id: FILE_ID,
        status: 'ready',
        transcriptionStatus: 'transcribing',
      }),
    ]);
    expect(announced()[0]).not.toHaveProperty('transcriptPath');
    expect(transition).not.toHaveBeenCalled();
  });

  describe('complete', () => {
    it('writes the transcript, then records it against the lease it was given', async () => {
      await recorder.complete(CLAIMED, LEASE, 'Good morning, everyone.', STARTED_AT);

      expect(writeText).toHaveBeenCalledWith(TRANSCRIPT_KEY, 'Good morning, everyone.');
      expect(transition).toHaveBeenCalledWith(
        FILE_ID,
        TRANSCRIBING,
        TRANSCRIBED,
        { transcriptKey: TRANSCRIPT_KEY },
        LEASE,
      );
      // Bytes before the row: a row that says transcribed must never point at nothing.
      expect(writeText.mock.invocationCallOrder[0]).toBeLessThan(
        transition.mock.invocationCallOrder[0] ?? 0,
      );
      expect(remove).not.toHaveBeenCalled();
    });

    it('announces the file as transcribed, with the path its transcript is served from', async () => {
      await recorder.complete(CLAIMED, LEASE, 'Good morning, everyone.', STARTED_AT);

      expect(announced()).toEqual([
        expect.objectContaining({
          id: FILE_ID,
          status: 'ready',
          transcriptionStatus: 'transcribed',
          transcriptPath: `/meetings/${MEETING_ID}/files/${FILE_ID}/transcript`,
        }),
      ]);
    });

    it('records a transcript that cannot be stored as a failed transcription, in fixed copy', async () => {
      writeText.mockRejectedValue(new Error('ENOSPC: no space left on device'));

      await recorder.complete(CLAIMED, LEASE, 'Good morning, everyone.', STARTED_AT);

      // One write, and it is the failure: the row is not left transcribing for its lease to
      // lapse and the recording to be transcribed from scratch.
      expect(transition.mock.calls).toEqual([
        [
          FILE_ID,
          TRANSCRIBING,
          FAILED,
          { transcriptionFailureReason: 'The recording could not be transcribed.' },
          LEASE,
        ],
      ]);
      expect(announced()).toEqual([
        expect.objectContaining({
          transcriptionStatus: 'failed',
          transcriptionFailureReason: 'The recording could not be transcribed.',
        }),
      ]);
      expect(JSON.stringify(announced())).not.toContain('ENOSPC');
    });

    it('removes the transcript it wrote, and announces nothing, when the file was deleted mid-run', async () => {
      // Zero rows, and the file is no longer `ready`: the purge may already have been and gone.
      transition.mockResolvedValue(false);
      isFileReady.mockResolvedValue(false);

      await recorder.complete(CLAIMED, LEASE, 'Good morning, everyone.', STARTED_AT);

      expect(isFileReady).toHaveBeenCalledWith(FILE_ID);
      expect(remove).toHaveBeenCalledWith(TRANSCRIPT_KEY);
      expect(publish).not.toHaveBeenCalled();
    });

    it('leaves the transcript alone when another worker has taken the claim over', async () => {
      // Zero rows, with the file still `ready`: the lease lapsed and the recording was claimed
      // again. The key is one per recording, so it may already hold what that claim recorded.
      transition.mockResolvedValue(false);
      isFileReady.mockResolvedValue(true);

      await recorder.complete(CLAIMED, LEASE, 'Good morning, everyone.', STARTED_AT);

      expect(remove).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('fail', () => {
    it('records the reason it was given and announces it, the file still ready', async () => {
      await recorder.fail(CLAIMED, LEASE, 'Fixed copy.', STARTED_AT);

      expect(transition).toHaveBeenCalledWith(
        FILE_ID,
        TRANSCRIBING,
        FAILED,
        { transcriptionFailureReason: 'Fixed copy.' },
        LEASE,
      );
      expect(announced()).toEqual([
        expect.objectContaining({
          status: 'ready',
          transcriptionStatus: 'failed',
          transcriptionFailureReason: 'Fixed copy.',
        }),
      ]);
      expect(announced()[0]).not.toHaveProperty('failureReason');
      expect(writeText).not.toHaveBeenCalled();
    });

    it('announces nothing when the failure could not be recorded', async () => {
      transition.mockResolvedValue(false);

      await recorder.fail(CLAIMED, LEASE, 'Fixed copy.', STARTED_AT);

      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('release', () => {
    it('hands the claim back through the repository and announces the file as queued again', async () => {
      await recorder.release(CLAIMED, LEASE, STARTED_AT);

      expect(release).toHaveBeenCalledWith(FILE_ID, LEASE);
      expect(transition).not.toHaveBeenCalled();
      expect(announced()).toEqual([
        expect.objectContaining({ status: 'ready', transcriptionStatus: 'queued' }),
      ]);
    });

    it('announces nothing when the claim was already gone', async () => {
      release.mockResolvedValue(false);

      await recorder.release(CLAIMED, LEASE, STARTED_AT);

      expect(publish).not.toHaveBeenCalled();
    });
  });
});
