import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventBus, QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { meetingFileTranscriptionTimeLimitMessage } from '@repo/shared';

import { MeetingFileChangedEvent } from '../../events/meeting-file-changed.event';
import { buildMeetingFileRecord } from '../../services/meeting-file-record.fixture';
import { TranscriptionStatus } from '../../services/meeting-file-transcription-status';
import { MeetingFileTranscriptionRepository } from '../../services/meeting-file-transcription.repository';
import { MeetingFileRepository } from '../../services/meeting-file.repository';
import { RetryMeetingFileTranscriptionCommand } from '../retry-meeting-file-transcription.command';
import {
  RetryMeetingFileTranscriptionHandler,
  TRANSCRIPTION_NOT_FAILED_MESSAGE,
} from './retry-meeting-file-transcription.handler';

const HOST_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const { QUEUED, FAILED } = TranscriptionStatus;

/** A recording that is `ready`, whose transcription failed on the fourth claim. */
const RECORD = buildMeetingFileRecord({
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  status: 'ready',
  processedAt: new Date('2026-10-07T10:00:01.000Z'),
  transcriptionStatus: FAILED,
  transcriptionFailureReason: 'Transcription failed after repeated attempts.',
  transcriptionAttempts: 4,
});
const { id: FILE_ID, meetingId: MEETING_ID, uploaderId: UPLOADER_ID } = RECORD;

const MEETING = {
  id: MEETING_ID,
  title: 'Engine review',
  status: 'scheduled',
  hostId: HOST_ID,
  scheduledAt: '2026-10-08T10:00:00.000Z',
  participantIds: [UPLOADER_ID, OTHER_ID],
};

describe('RetryMeetingFileTranscriptionHandler', () => {
  const execute = jest.fn();
  const findOneOf = jest.fn();
  const transition = jest.fn();
  const publish = jest.fn();
  let handler: RetryMeetingFileTranscriptionHandler;

  const retryAs = (userId: string) =>
    handler.execute(new RetryMeetingFileTranscriptionCommand(userId, MEETING_ID, FILE_ID));

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);
    findOneOf.mockReset().mockResolvedValue(RECORD);
    transition.mockReset().mockResolvedValue(true);
    publish.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        RetryMeetingFileTranscriptionHandler,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileRepository, useValue: { findOneOf } },
        { provide: MeetingFileTranscriptionRepository, useValue: { transition } },
        { provide: EventBus, useValue: { publish } },
      ],
    }).compile();

    handler = moduleRef.get(RetryMeetingFileTranscriptionHandler);
  });

  it.each([
    ['the uploader', UPLOADER_ID],
    ['the host', HOST_ID],
  ])('lets %s send a failed transcription back to the queue', async (_who, userId) => {
    const file = await retryAs(userId);

    expect(findOneOf).toHaveBeenCalledWith(MEETING_ID, FILE_ID);
    expect(transition).toHaveBeenCalledTimes(1);
    // A retry is a fresh chance, not one more claim against the worker's cap of three — and
    // the lease is `null`, because a failed transcription holds none.
    expect(transition).toHaveBeenCalledWith(
      FILE_ID,
      FAILED,
      QUEUED,
      { transcriptionAttempts: 0, transcriptionFailureReason: null },
      null,
    );
    // The file as written: ready as it was, queued, and without the reason it failed for.
    expect(file).toMatchObject({ id: FILE_ID, status: 'ready', transcriptionStatus: 'queued' });
    expect(file).not.toHaveProperty('transcriptionFailureReason');
    expect(file).not.toHaveProperty('transcriptPath');
  });

  it('answers 404 Meeting not found to a stranger before reading the file', async () => {
    execute.mockResolvedValue(null);

    await expect(retryAs(OTHER_ID)).rejects.toThrow(new NotFoundException('Meeting not found'));

    expect(findOneOf).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing or already deleted file', async () => {
    findOneOf.mockResolvedValue(null);

    await expect(retryAs(UPLOADER_ID)).rejects.toThrow(new NotFoundException('File not found'));

    expect(transition).not.toHaveBeenCalled();
  });

  it('answers 404 File not found to another participant, writing nothing', async () => {
    await expect(retryAs(OTHER_ID)).rejects.toThrow(new NotFoundException('File not found'));

    expect(transition).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('answers 409 for a transcription that outran the time limit, and writes nothing', async () => {
    // The same recording under the same limit ends the same way, with Whisper still
    // finishing the run that was hung up on.
    findOneOf.mockResolvedValue({
      ...RECORD,
      transcriptionFailureReason: meetingFileTranscriptionTimeLimitMessage(720),
    });

    await expect(retryAs(UPLOADER_ID)).rejects.toThrow(
      new ConflictException('A transcription that outran the time limit cannot be retried'),
    );

    expect(transition).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('answers 409 when no row changed — the transcription is not failed, or no longer is', async () => {
    transition.mockResolvedValue(false);

    await expect(retryAs(UPLOADER_ID)).rejects.toThrow(
      new ConflictException(TRANSCRIPTION_NOT_FAILED_MESSAGE),
    );

    expect(TRANSCRIPTION_NOT_FAILED_MESSAGE).toBe('Only a failed transcription can be retried');
    // The refusal changed nothing, so it announces nothing.
    expect(publish).not.toHaveBeenCalled();
  });

  it('announces the retried file once the transition has resolved', async () => {
    const order: string[] = [];
    transition.mockImplementation(async () => {
      await Promise.resolve();
      order.push('transition');

      return true;
    });
    publish.mockImplementation(() => order.push('publish'));

    const file = await retryAs(UPLOADER_ID);

    expect(order).toEqual(['transition', 'publish']);
    expect(publish).toHaveBeenCalledTimes(1);

    const [event] = publish.mock.calls[0] as [MeetingFileChangedEvent];
    expect(event).toBeInstanceOf(MeetingFileChangedEvent);
    expect(event.meetingId).toBe(MEETING_ID);
    // The same file the caller is answered with: one retry, one truth.
    expect(event.file).toEqual(file);
  });

  it('answers with the row as the retry left it, not as it was read', async () => {
    // Read while a worker still held it: it failed between that read and the retry's write.
    findOneOf.mockResolvedValue({
      ...RECORD,
      transcriptionStatus: TranscriptionStatus.TRANSCRIBING,
      transcriptionFailureReason: null,
      transcriptionLeasedUntil: new Date('2026-10-07T10:05:00.000Z'),
    });

    await expect(retryAs(HOST_ID)).resolves.toMatchObject({ transcriptionStatus: 'queued' });
  });
});
