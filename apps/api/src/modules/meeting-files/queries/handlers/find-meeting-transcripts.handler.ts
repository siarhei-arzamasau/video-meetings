import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { MeetingFileTranscriptionRepository } from '../../services/meeting-file-transcription.repository';
import type { TranscribedRecordingRecord } from '../../services/meeting-file-transcription.repository';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { FindMeetingTranscriptsQuery } from '../find-meeting-transcripts.query';
import type { MeetingTranscript, MeetingTranscripts } from '../find-meeting-transcripts.query';

/**
 * The most bytes UTF-8 spends on one UTF-16 code unit, which is what a string's `length`
 * counts: three for anything in the basic plane, and four for a pair of surrogates, which is
 * two units. So a file of more than three times as many bytes as there are characters left
 * cannot fit, and is known not to without being read.
 */
const MAX_UTF8_BYTES_PER_CHARACTER = 3;

/**
 * Reads a meeting's transcripts one after another, in upload order, and stops at the first
 * that takes the total past the limit.
 *
 * **What is in memory is bounded by the limit, not by the meeting.** A transcript is checked
 * by its size on disk before it is read, so the most this ever loads is the limit in
 * characters plus one file of at most three times that in bytes. One after another rather
 * than all at once for the same reason: fifty reads started together are fifty files held.
 *
 * A transcript that cannot be read — a recording deleted and purged between the list and the
 * read — rejects. The caller asked for the meeting's transcripts, and an answer that left
 * one out would be part of the meeting presented as the whole.
 */
@QueryHandler(FindMeetingTranscriptsQuery)
export class FindMeetingTranscriptsHandler implements IQueryHandler<
  FindMeetingTranscriptsQuery,
  MeetingTranscripts
> {
  constructor(
    private readonly transcriptions: MeetingFileTranscriptionRepository,
    private readonly storage: MeetingFileStorage,
  ) {}

  async execute({
    meetingId,
    maxCharacters,
  }: FindMeetingTranscriptsQuery): Promise<MeetingTranscripts> {
    const recordings = await this.transcriptions.findTranscribedOf(meetingId);
    const transcripts = await this.readInOrder(recordings, maxCharacters, []);

    return transcripts === null ? { withinLimit: false } : { withinLimit: true, transcripts };
  }

  /**
   * The transcripts of `recordings` after those already `read`, or `null` once one does not
   * fit in the characters that remain. Recursive rather than a loop with an await in it: each
   * read has to finish, and be counted, before the next is decided on.
   */
  private async readInOrder(
    recordings: ReadonlyArray<TranscribedRecordingRecord>,
    remainingCharacters: number,
    read: ReadonlyArray<MeetingTranscript>,
  ): Promise<ReadonlyArray<MeetingTranscript> | null> {
    const recording = recordings[read.length];

    if (recording === undefined) {
      return read;
    }

    const text = await this.readWithin(recording.transcriptKey, remainingCharacters);

    if (text === null) {
      return null;
    }

    return this.readInOrder(recordings, remainingCharacters - text.length, [
      ...read,
      { fileId: recording.id, text },
    ]);
  }

  /** The transcript under `key`, or `null` when it is more than `remainingCharacters`. */
  private async readWithin(key: string, remainingCharacters: number): Promise<string | null> {
    const { size } = await this.storage.stat(key);

    if (size > remainingCharacters * MAX_UTF8_BYTES_PER_CHARACTER) {
      return null;
    }

    const text = await this.storage.readText(key);

    return text.length > remainingCharacters ? null : text;
  }
}
