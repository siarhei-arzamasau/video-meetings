import type { MeetingFile } from '@repo/shared';

/** A recording whose transcript is stored: which file it is, and who uploaded it. */
export type TranscribedRecording = Pick<MeetingFile, 'id' | 'uploaderId'>;

/**
 * Resolves to a meeting's transcribed recordings — file `ready`, transcription `transcribed`,
 * not deleted — in upload order, and to an empty list for a meeting that has none or does not
 * exist.
 *
 * A read that crosses out of this module, for a caller that describes a meeting as a whole
 * and may not read this module's table: the digest is built from exactly these recordings.
 * **It carries no user and checks no visibility** — who may ask about the meeting is the
 * caller's to have decided, as it is for `FindUserByIdQuery`.
 */
export class FindTranscribedRecordingsQuery {
  constructor(readonly meetingId: string) {}
}
